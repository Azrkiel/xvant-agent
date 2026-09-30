import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import type { ProviderDispatch } from '../../../packages/storage/src/providers.ts';
import {
  ArtifactStore,
  safePath,
} from '../../../packages/storage/src/artifacts.ts';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import {
  ClaudeHeadlessStream,
  claudeArgs,
  type ClaudeTurnResult,
} from '../../../packages/adapters/src/live/claude-headless.ts';
import { LIVE_ROUTES } from '../../../packages/contracts/src/live.ts';
import type { InterruptAdmission } from '../../../packages/contracts/src/providers.ts';
import { NativeVerifier } from './native-verifier.ts';
import { NativeReviewController } from './native-review.ts';
import type { LiveEvent, LiveRunResult } from './codex-live.ts';

type Checks = Record<string, { executable: string; args: readonly string[] }>;
export interface LiveClaudeOptions {
  executable: string;
  prefixArgs?: readonly string[];
  timeoutMs?: number;
  checkTimeoutMs?: number;
  gitBases?: Record<string, string>;
  /** XVANT's task-scoped MCP bridge. The token stays out of the journal. */
  mcp?: { url: string; token: string; tools: readonly string[] };
  onEvent?: (event: LiveEvent) => void;
  fault?: (point: string) => void;
}
const MAX_TIMEOUT = 4 * 60 * 60 * 1000;
/** Variables that would bill an API account or confuse a nested Claude session. */
export function claudeUnsetEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((key) =>
    /^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|AWS_BEARER_TOKEN_BEDROCK$)/i.test(
      key,
    ),
  );
}

/**
 * Live headless Claude worker on the subscription login. One process per
 * turn; sessions are explicit UUIDs chosen by the host (`--session-id`) or
 * resumed by ID (`--resume`), never "latest". API-key variables are removed
 * from the child and the first frame must report `apiKeySource: none`.
 * Trusted-local: native Edit/Bash bypass XVANT approvals and receipts.
 */
export class LiveClaudeController {
  private readonly store: Store;
  private readonly supervisor = new WorkerSupervisor();
  private readonly verifier: NativeVerifier;
  private readonly review: NativeReviewController;
  private readonly workspaces: Record<string, string>;
  private readonly checks: Checks;
  private readonly options: LiveClaudeOptions & {
    prefixArgs: readonly string[];
    timeoutMs: number;
  };
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
    options: LiveClaudeOptions,
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
  /**
   * `create` uses the worker's nativeSessionId as the new session's UUID;
   * `resume` continues it. Both reserve that exact session before launch.
   */
  async run(
    input: ProviderDispatch,
    mode: 'create' | 'resume',
  ): Promise<LiveRunResult> {
    input = structuredClone(input);
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    if (
      input.classification !== 'live' ||
      input.worker.runtimeKind !== 'claude' ||
      input.worker.runtimeVersion !== LIVE_ROUTES.claude.runtimeVersion ||
      input.worker.adapterVersion !== LIVE_ROUTES.claude.adapterVersion ||
      !['create', 'resume'].includes(mode)
    )
      throw new Error('VERSION_UNSUPPORTED');
    const approval = input.liveApproval;
    if (!approval) throw new Error('LIVE_APPROVAL_REQUIRED');
    const root = this.workspaces[input.workspaceId];
    if (!Object.hasOwn(this.workspaces, input.workspaceId) || !root)
      throw new Error('WORKSPACE_UNAVAILABLE');
    safePath(root);
    const task = this.store.getTask(input.taskId);
    if (task.requiredCheckIds.some((id) => !Object.hasOwn(this.checks, id)))
      throw new Error('VERIFIER_UNAVAILABLE');
    const profile =
      approval.profile === 'workspace-write' ? 'workspace-write' : 'text';
    const session = input.worker.nativeSessionId;
    const mcp = this.options.mcp;
    const mcpConfig = mcp
      ? join(tmpdir(), 'xvant-mcp-' + randomBytes(12).toString('hex') + '.json')
      : undefined;
    const args = [
      ...this.options.prefixArgs,
      ...claudeArgs({
        mode,
        sessionId: session,
        model: approval.model,
        profile,
        ...(mcp && mcpConfig
          ? { mcp: { configPath: mcpConfig, tools: mcp.tools } }
          : {}),
      }),
    ];
    const unsetEnv = claudeUnsetEnv();
    await this.checkVersion(root, input, unsetEnv);
    const connection = this.store.providers.reserve(input);
    const id = connection.connectionId,
      token = connection.token;
    const emit = (kind: LiveEvent['kind'], text: string) => {
      try {
        this.options.onEvent?.({ connectionId: id, kind, text });
      } catch {
        /* Observers cannot affect execution. */
      }
    };
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat();
      } catch {
        this.stop();
      }
    }, this.store.heartbeatIntervalMs);
    heartbeat.unref();
    let run: ReturnType<WorkerSupervisor['start']> | undefined;
    let failed = false,
      interrupted = false;
    let result: ClaudeTurnResult | undefined;
    const stream = new ClaudeHeadlessStream(session, profile);
    const unknown = () => {
      try {
        this.store.providers.unknown(id, token);
      } catch {
        /* A new owner retains the reservation. */
      }
    };
    try {
      // The bridge token lives only in this private file, never in the journal.
      if (mcp && mcpConfig)
        writeFileSync(
          mcpConfig,
          JSON.stringify({
            mcpServers: {
              xvant: {
                type: 'http',
                url: mcp.url,
                headers: { Authorization: 'Bearer ' + mcp.token },
              },
            },
          }),
          { flag: 'wx', mode: 0o600 },
        );
      this.store.providers.recordIntent(id, token, {
        id: 1,
        method: 'claude/headless-run',
        frame: JSON.stringify({ args, mode, prompt: task.objective }),
      });
      this.options.fault?.('claude-live.after_intent');
      this.store.providers.assertWritable(id, token);
      if (this.stopped) throw new Error('CONTROLLER_STOPPED');
      run = this.supervisor.start({
        executable: this.options.executable,
        args,
        cwd: root,
        workerId: input.worker.id,
        attemptId: input.attemptId,
        generation: connection.generation,
        timeoutMs: this.options.timeoutMs,
        maxOutputBytes: 1048576,
        userApprovedTrustedLocal: true,
        unsetEnv,
        interactive: {
          retainStdout: false,
          onStdout: (bytes) => {
            try {
              const { frames, signals } = stream.receive(bytes);
              for (const frame of frames)
                if (
                  frame.type !== 'stream_event' &&
                  frame.type !== 'rate_limit_event'
                )
                  this.store.providers.recordMessage(id, token, frame);
              for (const signal of signals)
                emit(
                  signal.kind === 'init'
                    ? 'auth'
                    : signal.kind === 'retry'
                      ? 'activity'
                      : signal.kind,
                  signal.kind === 'init'
                    ? signal.auth + '/' + signal.model
                    : signal.text,
                );
            } catch {
              failed = true;
              unknown();
              if (run) this.supervisor.cancel(run.identity);
            }
          },
        },
      });
      await run.write(task.objective);
      run.endInput();
      this.interrupts.set(id, (actorId) => {
        if (interrupted) return { status: 'already_requested' };
        if (failed || !stream.started || stream.finished)
          throw new Error('NOT_INTERRUPTIBLE');
        this.store.providers.requestInterrupt(id, token, actorId);
        interrupted = true;
        this.supervisor.cancel(run!.identity);
        return { status: 'requested' };
      });
      const stopped = await run.result;
      this.interrupts.delete(id);
      this.options.fault?.('claude-live.after_shutdown');
      if (interrupted && !stream.finished && stopped.reason === 'cancelled') {
        // The process that owned the turn is gone; the turn cannot continue.
        const runId = 'interrupted:' + input.attemptId;
        this.store.providers.bindRun(id, token, runId);
        this.store.providers.finish(id, token, runId, 'cancelled');
        return this.outcome(input.taskId, undefined);
      }
      if (failed || interrupted || this.stopped || stopped.reason !== 'exited')
        throw new Error('OPERATION_UNKNOWN');
      result = stream.end();
      if (result.kind === 'completed' && stopped.exitCode !== 0)
        throw new Error('OPERATION_UNKNOWN');
      if (result.failure)
        this.store.providers.recordFailure(id, token, result.failure);
      this.store.providers.bindRun(id, token, result.runId);
      this.store.providers.finish(id, token, result.runId, result.kind);
      if (result.kind === 'completed') {
        emit('usage', String(result.tokens ?? 'unknown'));
        const checked = await this.verifier.verify(id, token, {
          stopped: true,
        });
        if (checked.status === 'passed' && !this.stopped)
          this.review.prepare(
            id,
            id,
            this.store.getTask(input.taskId).rowVersion,
          );
      }
    } catch {
      unknown();
      if (run) this.supervisor.cancel(run.identity);
    } finally {
      this.interrupts.delete(id);
      if (run) await run.result;
      if (mcpConfig) rmSync(mcpConfig, { force: true });
      clearInterval(heartbeat);
    }
    return this.outcome(input.taskId, result);
  }
  private outcome(taskId: string, result: ClaudeTurnResult | undefined) {
    return {
      task: this.store.getTask(taskId),
      finalText: result?.text ?? '',
      tokens: result?.tokens ?? null,
      auth: result ? { mode: 'claude.ai', plan: 'subscription' } : null,
    };
  }
  private async checkVersion(
    root: string,
    input: ProviderDispatch,
    unsetEnv: string[],
  ) {
    const probe = await this.supervisor.start({
      executable: this.options.executable,
      args: [...this.options.prefixArgs, '--version'],
      cwd: root,
      workerId: input.worker.id,
      attemptId: input.attemptId,
      generation: 1,
      timeoutMs: 30000,
      maxOutputBytes: 16384,
      userApprovedTrustedLocal: true,
      unsetEnv,
    }).result;
    if (
      probe.reason !== 'exited' ||
      probe.exitCode !== 0 ||
      probe.stdout.trim() !==
        LIVE_ROUTES.claude.runtimeVersion + ' (Claude Code)'
    )
      throw new Error('VERSION_UNSUPPORTED');
  }
  stop(): void {
    this.stopped = true;
    this.supervisor.stopAll();
    this.verifier.stop();
  }
}
