import { isAbsolute } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import type {
  ProviderConnection,
  ProviderDispatch,
} from '../../../packages/storage/src/providers.ts';
import {
  ArtifactStore,
  safePath,
} from '../../../packages/storage/src/artifacts.ts';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import { durableCodexChannel } from '../../../packages/adapters/src/codex/durable.ts';
import { CodexLifecycle } from '../../../packages/adapters/src/codex/lifecycle.ts';
import {
  CODEX_VERSION,
  validateNative,
} from '../../../packages/adapters/src/codex/profile.ts';
import { LIVE_ROUTES } from '../../../packages/contracts/src/live.ts';
import type { InterruptAdmission } from '../../../packages/contracts/src/providers.ts';
import { NativeVerifier } from './native-verifier.ts';
import { NativeReviewController } from './native-review.ts';

type Checks = Record<string, { executable: string; args: readonly string[] }>;
export interface LiveEvent {
  connectionId: string;
  kind: 'text' | 'activity' | 'usage' | 'auth';
  text: string;
}
export interface LiveCodexOptions {
  executable: string;
  /** Arguments before `app-server`; tests use them to launch a fixture. */
  prefixArgs?: readonly string[];
  /** Whole-session deadline. Real coding turns take minutes. */
  timeoutMs?: number;
  checkTimeoutMs?: number;
  /** Workspaces that are Git worktrees, with their base commits. */
  gitBases?: Record<string, string>;
  onEvent?: (event: LiveEvent) => void;
  fault?: (point: string) => void;
}
export interface LiveRunResult {
  task: ReturnType<Store['getTask']>;
  finalText: string;
  tokens: number | null;
  auth: { mode: string; plan: string } | null;
}
// Streamed deltas, usage and status telemetry confer no authority; journaling
// every one would bound session length by journal size instead of by work.
const TELEMETRY =
  /(delta|Delta)$|^(thread\/tokenUsage\/updated|account\/rateLimits\/updated|mcpServer\/startupStatus\/updated|remoteControl\/status\/changed|thread\/status\/changed)$/;
const MAX_TIMEOUT = 4 * 60 * 60 * 1000;

/**
 * Live Codex app-server worker on the subscription login. Trusted-local:
 * under `workspace-write` Codex's own sandbox confines edits to the worktree,
 * but its tools bypass XVANT approvals and receipts. Never falls back to an
 * API key: a session whose auth mode is not `chatgpt` is stopped before any
 * thread or turn is sent.
 */
export class LiveCodexController {
  private readonly store: Store;
  private readonly supervisor = new WorkerSupervisor();
  private readonly verifier: NativeVerifier;
  private readonly review: NativeReviewController;
  private readonly workspaces: Record<string, string>;
  private readonly checks: Checks;
  private readonly options: Required<
    Pick<LiveCodexOptions, 'executable' | 'prefixArgs' | 'timeoutMs'>
  > &
    LiveCodexOptions;
  private readonly interrupts = new Map<
    string,
    (actorId: string) => InterruptAdmission
  >();
  private stopped = false;
  constructor(
    store: Store,
    objects: ArtifactStore,
    workspaces: Record<string, string>,
    checks: Checks,
    options: LiveCodexOptions,
  ) {
    this.store = store;
    this.workspaces = structuredClone(workspaces);
    this.checks = structuredClone(checks);
    this.options = {
      ...options,
      prefixArgs: [...(options.prefixArgs ?? [])],
      timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
    };
    if (
      !isAbsolute(options.executable) ||
      !Number.isSafeInteger(this.options.timeoutMs) ||
      this.options.timeoutMs < 1 ||
      this.options.timeoutMs > MAX_TIMEOUT
    )
      throw new Error('INVALID_INPUT');
    this.verifier = new NativeVerifier(store, objects, workspaces, checks, {
      timeoutMs: options.checkTimeoutMs ?? 10 * 60 * 1000,
      gitBases: options.gitBases ?? {},
      maxCheckOutputBytes: 8 * 1024 * 1024,
    });
    this.review = new NativeReviewController(store, objects);
  }
  get activeCount(): number {
    return this.supervisor.activeCount;
  }
  interrupt(connectionId: string, actorId: string): InterruptAdmission {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    const admit = this.interrupts.get(connectionId);
    if (!admit) throw new Error('NOT_FOUND');
    return admit(actorId);
  }
  async run(
    input: ProviderDispatch,
    mode: 'create' | 'resume',
  ): Promise<LiveRunResult> {
    input = structuredClone(input);
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    if (
      input.classification !== 'live' ||
      input.worker.runtimeKind !== 'codex' ||
      input.worker.runtimeVersion !== LIVE_ROUTES.codex.runtimeVersion ||
      input.worker.adapterVersion !== LIVE_ROUTES.codex.adapterVersion ||
      !['create', 'resume'].includes(mode)
    )
      throw new Error('VERSION_UNSUPPORTED');
    if (!input.liveApproval) throw new Error('LIVE_APPROVAL_REQUIRED');
    const root = this.workspaces[input.workspaceId];
    if (!Object.hasOwn(this.workspaces, input.workspaceId) || !root)
      throw new Error('WORKSPACE_UNAVAILABLE');
    safePath(root);
    const task = this.store.getTask(input.taskId);
    if (task.requiredCheckIds.some((id) => !Object.hasOwn(this.checks, id)))
      throw new Error('VERIFIER_UNAVAILABLE');
    await this.checkVersion(root, input);
    const connection = this.store.providers.reserve(
      mode === 'create'
        ? {
            ...input,
            worker: {
              ...input.worker,
              nativeSessionId: 'pending:' + input.connectionId,
            },
          }
        : input,
    );
    this.options.fault?.('codex-live.after_reserve');
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat();
      } catch {
        this.stop();
      }
    }, this.store.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      return await this.execute(connection, root, mode, task.objective);
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async checkVersion(root: string, input: ProviderDispatch) {
    const probe = await this.supervisor.start({
      executable: this.options.executable,
      args: [...this.options.prefixArgs, '--version'],
      cwd: root,
      workerId: input.worker.id,
      attemptId: input.attemptId,
      generation: 1,
      timeoutMs: 15000,
      maxOutputBytes: 16384,
      userApprovedTrustedLocal: true,
    }).result;
    if (
      probe.reason !== 'exited' ||
      probe.exitCode !== 0 ||
      probe.stdout.trim() !== 'codex-cli ' + CODEX_VERSION
    )
      throw new Error('VERSION_UNSUPPORTED');
  }
  private async execute(
    connection: ProviderConnection,
    root: string,
    mode: 'create' | 'resume',
    objective: string,
  ): Promise<LiveRunResult> {
    const approval = connection.liveApproval!;
    const life = new CodexLifecycle(
      CODEX_VERSION,
      mode === 'resume' ? connection.worker.nativeSessionId : undefined,
      {
        profile:
          approval.profile === 'workspace-write'
            ? 'workspace-write'
            : 'read-only',
        model: approval.model,
      },
    );
    const id = connection.connectionId;
    const emit = (kind: LiveEvent['kind'], text: string) => {
      try {
        this.options.onEvent?.({ connectionId: id, kind, text });
      } catch {
        /* Observers cannot affect execution. */
      }
    };
    let run!: ReturnType<WorkerSupervisor['start']>;
    let ending = false,
      failed = false,
      interruptRequested = false;
    let outcome: 'completed' | 'cancelled' | 'failed' | undefined;
    let interruptReply: Promise<void> | undefined;
    let finalText = '',
      tokens: number | null = null;
    let auth: { mode: string; plan: string } | null = null;
    let resolveTerminal!: () => void, rejectTerminal!: (e: Error) => void;
    const terminal = new Promise<void>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    void terminal.catch(() => {});
    let resolveAuth!: () => void;
    const authSeen = new Promise<void>((resolve) => (resolveAuth = resolve));
    const classify = () => {
      if (life.failure && !interruptRequested)
        this.store.providers.recordFailure(id, connection.token, life.failure);
    };
    const fail = () => {
      failed = true;
      try {
        classify();
      } catch {
        /* Uncertainty is recorded durably below. */
      }
      life.disconnected();
      rejectTerminal(new Error('OPERATION_UNKNOWN'));
      try {
        channel.close();
      } catch {
        /* Already unknown. */
      }
      if (run) this.supervisor.cancel(run.identity);
    };
    this.interrupts.set(id, (actorId) => {
      if (interruptRequested) return { status: 'already_requested' };
      if (failed || life.status !== 'running')
        throw new Error('NOT_INTERRUPTIBLE');
      this.store.providers.requestInterrupt(id, connection.token, actorId);
      interruptRequested = true;
      const interrupt = life.interrupt();
      interruptReply = channel
        .request(interrupt.method, interrupt.params)
        .then((reply) => validateNative('TurnInterruptResponse', reply));
      void interruptReply.catch(fail);
      return { status: 'requested' };
    });
    const channel = durableCodexChannel(this.store, connection, {
      timeoutMs: 60000,
      maxFrameBytes: 1048576,
      journal: (message) =>
        typeof message.method !== 'string' || !TELEMETRY.test(message.method),
      write: (frame) => {
        if (this.stopped) throw new Error('CONTROLLER_STOPPED');
        return run.write(frame);
      },
      onMessage: (message) => {
        const params = (message.params ?? {}) as Record<string, unknown>;
        if (message.method === 'account/updated') {
          auth = {
            mode: String(params.authMode ?? 'unknown'),
            plan: String(params.planType ?? 'unknown'),
          };
          emit('auth', auth.mode + '/' + auth.plan);
          // Subscription only. Anything else is stopped, never used.
          if (auth.mode !== 'chatgpt') throw new Error('BILLING_UNVERIFIED');
          resolveAuth();
          return;
        }
        if (message.method === 'thread/tokenUsage/updated') {
          const total = (
            params.tokenUsage as { total?: { totalTokens?: unknown } }
          )?.total?.totalTokens;
          if (Number.isSafeInteger(total)) {
            tokens = total as number;
            emit('usage', String(tokens));
          }
          return;
        }
        if (message.method === 'item/completed') {
          const item = params.item as
            { type?: string; text?: unknown } | undefined;
          if (item?.type === 'agentMessage' && typeof item.text === 'string')
            finalText = item.text.slice(0, 65536);
          else if (item?.type) emit('activity', item.type);
          return;
        }
        const action = life.message(message);
        if (action.kind === 'started')
          this.store.providers.bindRun(
            id,
            connection.token,
            action.nativeRunId,
          );
        else if (action.kind === 'output') emit('text', action.text);
        else if (action.kind === 'deny')
          void channel.respond(action.id, action.result).catch(fail);
        else if (
          action.kind === 'completed' ||
          action.kind === 'cancelled' ||
          action.kind === 'failed'
        ) {
          outcome = action.kind;
          resolveTerminal();
        }
      },
    });
    try {
      run = this.supervisor.start({
        executable: this.options.executable,
        args: [...this.options.prefixArgs, 'app-server'],
        cwd: root,
        workerId: connection.worker.id,
        attemptId: connection.attemptId,
        generation: connection.generation,
        timeoutMs: this.options.timeoutMs,
        maxOutputBytes: 1048576,
        userApprovedTrustedLocal: true,
        interactive: {
          retainStdout: false,
          onStdout: (bytes) => {
            try {
              channel.receive(bytes);
            } catch {
              fail();
            }
          },
        },
      });
      void run.result.then(() => {
        if (!ending) fail();
      });
      const init = life.initialize();
      const initialized = life.initialized(
        await channel.request(init.method, init.params),
      );
      await channel.notify(initialized.method, initialized.params);
      await Promise.race([
        authSeen,
        terminal,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('BILLING_UNVERIFIED')), 30000),
        ),
      ]);
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      const thread = life.openThread(mode, root);
      life.threadOpened(await channel.request(thread.method, thread.params));
      if (mode === 'create')
        this.store.providers.bindSession(
          id,
          connection.token,
          life.nativeSessionId!,
        );
      this.options.fault?.('codex-live.after_session');
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      const start = life.start(objective);
      life.started(await channel.request(start.method, start.params));
      this.store.providers.bindRun(id, connection.token, life.nativeRunId!);
      await terminal;
      if (interruptRequested) {
        if (!interruptReply) throw new Error('OPERATION_UNKNOWN');
        await interruptReply;
        if (outcome !== 'cancelled') throw new Error('OPERATION_UNKNOWN');
      }
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      ending = true;
      run.endInput();
      const stopped = await run.result;
      if (
        failed ||
        this.stopped ||
        stopped.reason !== 'exited' ||
        stopped.exitCode !== 0
      )
        throw new Error('OPERATION_UNKNOWN');
      channel.endReceive();
      this.options.fault?.('codex-live.after_shutdown');
      if (outcome === 'failed') classify();
      this.store.providers.finish(
        id,
        connection.token,
        life.nativeRunId!,
        outcome!,
      );
      channel.close();
      if (outcome === 'completed') {
        const result = await this.verifier.verify(id, connection.token, {
          stopped: true,
        });
        if (result.status === 'passed' && !this.stopped)
          this.review.prepare(
            id,
            id,
            this.store.getTask(connection.taskId).rowVersion,
          );
      }
    } catch {
      fail();
    } finally {
      this.interrupts.delete(id);
      ending = true;
      try {
        channel.close();
      } catch {
        /* Partial frame is already unknown. */
      }
      if (run) {
        if (failed) this.supervisor.cancel(run.identity);
        await run.result;
      }
    }
    return {
      task: this.store.getTask(connection.taskId),
      finalText,
      tokens,
      auth,
    };
  }
  stop(): void {
    this.stopped = true;
    this.supervisor.stopAll();
    this.verifier.stop();
  }
}
