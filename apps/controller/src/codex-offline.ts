import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from '../../../packages/storage/src/store.ts';
import type {
  ProviderDispatch,
  ProviderConnection,
} from '../../../packages/storage/src/providers.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import { durableCodexChannel } from '../../../packages/adapters/src/codex/durable.ts';
import { CodexLifecycle } from '../../../packages/adapters/src/codex/lifecycle.ts';
import {
  CODEX_VERSION,
  validateNative,
} from '../../../packages/adapters/src/codex/profile.ts';
import type { InterruptAdmission } from '../../../packages/contracts/src/providers.ts';
import { NativeVerifier } from './native-verifier.ts';
import { NativeReviewController } from './native-review.ts';

const scenarioSchema = z.enum([
  'success',
  'approval',
  'interrupt',
  'interrupt-error',
  'interrupt-ignored',
  'disconnect',
  'malformed',
  'timeout',
  'late-malformed',
  'late-partial',
  'thread-rpc-error',
  'thread-mismatch',
  'thread-malformed',
  'thread-disconnect',
  'thread-timeout',
  'native-error',
  'native-retry',
  'turn-rpc-error',
  'turn-failed',
  'auth-failed',
]);
/** Complete host orchestration using only a fixed synthetic peer. No live launcher. */
export class OfflineCodexController {
  private readonly store: Store;
  private readonly workspaces: Record<string, string>;
  private readonly checks: Record<
    string,
    { executable: string; args: readonly string[] }
  >;
  private readonly supervisor = new WorkerSupervisor();
  private readonly verifier: NativeVerifier;
  private readonly review: NativeReviewController;
  private readonly timeout: number;
  private readonly fault: (point: string) => void;
  private readonly interrupts = new Map<
    string,
    (actorId: string) => InterruptAdmission
  >();
  private stopped = false;
  constructor(
    store: Store,
    objects: ArtifactStore,
    workspaces: Record<string, string>,
    checks: Record<string, { executable: string; args: readonly string[] }>,
    options: { timeoutMs?: number; fault?: (point: string) => void } = {},
  ) {
    this.store = store;
    this.workspaces = structuredClone(workspaces);
    this.checks = structuredClone(checks);
    this.timeout = options.timeoutMs ?? 5000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60000
    )
      throw new Error('INVALID_INPUT');
    this.fault = options.fault ?? (() => {});
    this.verifier = new NativeVerifier(store, objects, workspaces, checks, {
      timeoutMs: this.timeout,
    });
    this.review = new NativeReviewController(store, objects);
  }
  get activeCount(): number {
    return this.supervisor.activeCount;
  }
  /**
   * Host-only admission of `turn/interrupt` for a running turn this controller
   * owns. Admission commits before the request is journaled and written.
   * `cancelled` also requires the reply, an interrupted terminal turn and owned
   * shutdown; anything else stays unknown. Never exposed to providers.
   */
  interrupt(connectionId: string, actorId: string): InterruptAdmission {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    const admit = this.interrupts.get(connectionId);
    if (!admit) throw new Error('NOT_FOUND');
    return admit(actorId);
  }
  async run(
    input: ProviderDispatch,
    scenarioInput: string = 'success',
    modeInput: 'create' | 'resume' = 'resume',
  ) {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    const scenario = scenarioSchema.parse(scenarioInput);
    const mode = z.enum(['create', 'resume']).parse(modeInput);
    if (
      input.worker.runtimeKind !== 'codex' ||
      input.worker.runtimeVersion !== CODEX_VERSION
    )
      throw new Error('VERSION_UNSUPPORTED');
    const root = this.workspaces[input.workspaceId];
    if (!Object.hasOwn(this.workspaces, input.workspaceId) || !root)
      throw new Error('WORKSPACE_UNAVAILABLE');
    const task = this.store.getTask(input.taskId);
    if (
      task.requiredCheckIds.some((check) => !Object.hasOwn(this.checks, check))
    )
      throw new Error('VERIFIER_UNAVAILABLE');
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
    this.fault('codex.after_reserve');
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat();
      } catch {
        this.stop();
      }
    }, this.store.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      return await this.execute(connection, scenario, root, mode);
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async execute(
    connection: ProviderConnection,
    scenario: string,
    root: string,
    mode: 'create' | 'resume',
  ) {
    const life = new CodexLifecycle(
      CODEX_VERSION,
      mode === 'resume' ? connection.worker.nativeSessionId : undefined,
    );
    let run!: ReturnType<WorkerSupervisor['start']>;
    let ending = false,
      failed = false;
    let outcome: 'completed' | 'cancelled' | 'failed' | undefined;
    let resolveTerminal!: () => void, rejectTerminal!: (error: Error) => void;
    const terminal = new Promise<void>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    void terminal.catch(() => {});
    let interruptRequested = false;
    let interruptReply: Promise<void> | undefined;
    const classify = () => {
      if (life.failure && !interruptRequested)
        this.store.providers.recordFailure(
          connection.connectionId,
          connection.token,
          life.failure,
        );
    };
    const fail = () => {
      failed = true;
      try {
        classify();
      } catch {
        /* Classification is advisory; uncertainty is recorded durably. */
      }
      life.disconnected();
      rejectTerminal(new Error('OPERATION_UNKNOWN'));
      try {
        channel.close();
      } catch {
        /* Unknown outcome is retained durably. */
      }
      if (run) this.supervisor.cancel(run.identity);
    };
    this.interrupts.set(connection.connectionId, (actorId) => {
      if (interruptRequested) return { status: 'already_requested' };
      if (failed || life.status !== 'running')
        throw new Error('NOT_INTERRUPTIBLE');
      this.store.providers.requestInterrupt(
        connection.connectionId,
        connection.token,
        actorId,
      );
      interruptRequested = true;
      this.fault('codex.after_interrupt_request');
      const interrupt = life.interrupt();
      interruptReply = channel
        .request(interrupt.method, interrupt.params)
        .then((reply) => {
          validateNative('TurnInterruptResponse', reply);
        });
      void interruptReply.catch(fail);
      return { status: 'requested' };
    });
    const channel = durableCodexChannel(this.store, connection, {
      timeoutMs: this.timeout,
      write: (frame) => {
        if (this.stopped) throw new Error('CONTROLLER_STOPPED');
        return run.write(frame);
      },
      onMessage: (message) => {
        const action = life.message(message);
        if (action.kind === 'started')
          this.store.providers.bindRun(
            connection.connectionId,
            connection.token,
            action.nativeRunId,
          );
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
        executable: process.execPath,
        args: [
          fileURLToPath(
            new URL('../../../tests/fixtures/codex-peer.mjs', import.meta.url),
          ),
          scenario,
        ],
        cwd: root,
        workerId: connection.worker.id,
        attemptId: connection.attemptId,
        generation: connection.generation,
        timeoutMs: this.timeout,
        maxOutputBytes: 1024 * 1024,
        userApprovedTrustedLocal: true,
        interactive: {
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
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      const thread = life.openThread(mode, root);
      life.threadOpened(await channel.request(thread.method, thread.params));
      if (mode === 'create')
        this.store.providers.bindSession(
          connection.connectionId,
          connection.token,
          life.nativeSessionId!,
        );
      this.fault('codex.after_session');
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      const start = life.start(this.store.getTask(connection.taskId).objective);
      life.started(await channel.request(start.method, start.params));
      this.store.providers.bindRun(
        connection.connectionId,
        connection.token,
        life.nativeRunId!,
      );
      if (life.status === 'running') this.fault('codex.interruptible');
      await terminal;
      if (interruptRequested) {
        if (!interruptReply) throw new Error('OPERATION_UNKNOWN');
        await interruptReply;
        // A completed turn after an admitted interrupt is ambiguous, not success.
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
        stopped.exitCode !== 0 ||
        stopped.outputTruncated
      )
        throw new Error('OPERATION_UNKNOWN');
      channel.endReceive();
      this.fault('codex.after_shutdown');
      if (outcome === 'failed') classify();
      this.store.providers.finish(
        connection.connectionId,
        connection.token,
        life.nativeRunId!,
        outcome!,
      );
      channel.close();
      if (outcome === 'completed') {
        const result = await this.verifier.verify(
          connection.connectionId,
          connection.token,
          { stopped: true },
        );
        if (result.status === 'passed' && !this.stopped) {
          this.fault('codex.before_review');
          this.review.prepare(
            connection.connectionId,
            connection.connectionId,
            this.store.getTask(connection.taskId).rowVersion,
          );
        }
      }
    } catch {
      fail();
    } finally {
      this.interrupts.delete(connection.connectionId);
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
    return this.store.getTask(connection.taskId);
  }
  stop(): void {
    this.stopped = true;
    this.supervisor.stopAll();
    this.verifier.stop();
  }
}
