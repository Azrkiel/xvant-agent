import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import type { ProviderDispatch } from '../../../packages/storage/src/providers.ts';
import {
  ArtifactStore,
  safePath,
} from '../../../packages/storage/src/artifacts.ts';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import {
  OpenCodeCliStream,
  OPENCODE_CLI_VERSION,
} from '../../../packages/adapters/src/opencode/cli-stream.ts';
import { NativeVerifier } from './native-verifier.ts';
import { NativeReviewController } from './native-review.ts';
import type { InterruptAdmission } from '../../../packages/contracts/src/providers.ts';
import { FREE_OPENCODE_MODELS } from '../../../packages/contracts/src/live.ts';
import { OpenCodeRunStream } from '../../../packages/adapters/src/live/opencode-run.ts';
import type { LiveEvent, LiveRunResult } from './codex-live.ts';

type Checks = Record<string, { executable: string; args: readonly string[] }>;
interface Options {
  executable: string;
  prefixArgs?: readonly string[];
  timeoutMs?: number;
  checkTimeoutMs?: number;
  /** Git worktree workspaces and their base commits (workspace-write). */
  gitBases?: Record<string, string>;
  /** XVANT's task-scoped MCP bridge; the token stays in the child's environment. */
  mcp?: { url: string; token: string; tools: readonly string[] };
  onEvent?: (event: LiveEvent) => void;
  fault?: (point: string) => void;
}
/**
 * Config for workspace-write runs: edit and shell in the worktree, no web,
 * and XVANT's bridge as the only added MCP server.
 */
function writeConfig(mcp?: Options['mcp']): string {
  return JSON.stringify({
    permission: { edit: 'allow', bash: 'allow', webfetch: 'deny' },
    ...(mcp
      ? {
          mcp: {
            xvant: {
              type: 'remote',
              url: mcp.url,
              enabled: true,
              headers: { Authorization: 'Bearer ' + mcp.token },
            },
          },
        }
      : {}),
  });
}
/**
 * Trusted-local, explicitly approved OpenCode CLI execution on free models.
 * 	ext answers into a host-written result file; workspace-write lets the
 * worker's tools edit its Git worktree. Not OS containment.
 */
export class LiveOpenCodeController {
  private readonly supervisor = new WorkerSupervisor();
  private readonly verifier: NativeVerifier;
  private readonly review: NativeReviewController;
  private readonly workspaces: Record<string, string>;
  private readonly checks: Checks;
  private readonly options: Options;
  private readonly interrupts = new Map<
    string,
    (actor: string) => InterruptAdmission
  >();
  private stopped = false;
  private busy = false;
  private readonly store: Store;
  constructor(
    store: Store,
    objects: ArtifactStore,
    workspaces: Record<string, string>,
    checks: Checks,
    options: Options,
  ) {
    this.store = store;
    this.workspaces = structuredClone(workspaces);
    this.checks = structuredClone(checks);
    this.options = {
      ...options,
      prefixArgs: [...(options.prefixArgs ?? [])],
      timeoutMs: options.timeoutMs ?? 60000,
    };
    if (
      !isAbsolute(options.executable) ||
      !Number.isSafeInteger(this.options.timeoutMs) ||
      this.options.timeoutMs! < 1 ||
      this.options.timeoutMs! > 4 * 60 * 60 * 1000
    )
      throw new Error('INVALID_INPUT');
    this.verifier = new NativeVerifier(store, objects, workspaces, checks, {
      timeoutMs: Math.min(
        options.checkTimeoutMs ?? this.options.timeoutMs!,
        3_600_000,
      ),
      gitBases: options.gitBases ?? {},
      maxCheckOutputBytes: 8 * 1024 * 1024,
    });
    this.review = new NativeReviewController(store, objects);
  }
  get activeCount() {
    return this.supervisor.activeCount;
  }
  interrupt(id: string, actor: string): InterruptAdmission {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    const call = this.interrupts.get(id);
    if (!call) throw new Error('NOT_FOUND');
    return call(actor);
  }
  async run(input: ProviderDispatch, resumeFromConnectionId?: string) {
    return (await this.runLive(input, resumeFromConnectionId)).task;
  }
  async runLive(
    input: ProviderDispatch,
    resumeFromConnectionId?: string,
  ): Promise<LiveRunResult> {
    input = structuredClone(input);
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    if (this.busy) throw new Error('CAPACITY_LIMIT');
    if (
      input.classification !== 'live' ||
      input.worker.runtimeKind !== 'opencode' ||
      input.worker.runtimeVersion !== OPENCODE_CLI_VERSION ||
      input.worker.adapterVersion !== 'opencode-cli-v2'
    )
      throw new Error('VERSION_UNSUPPORTED');
    if (
      !input.liveApproval ||
      !(FREE_OPENCODE_MODELS as readonly string[]).includes(
        input.liveApproval.model,
      ) ||
      input.liveApproval.transport !== 'cli' ||
      input.liveApproval.userApprovedTrustedLocal !== true ||
      !input.liveApproval.actorId
    )
      throw new Error('LIVE_APPROVAL_REQUIRED');
    const root = this.workspaces[input.workspaceId];
    if (!Object.hasOwn(this.workspaces, input.workspaceId) || !root)
      throw new Error('WORKSPACE_UNAVAILABLE');
    safePath(root);
    const task = this.store.getTask(input.taskId);
    if (task.requiredCheckIds.some((id) => !Object.hasOwn(this.checks, id)))
      throw new Error('VERIFIER_UNAVAILABLE');
    const write = input.liveApproval.profile === 'workspace-write';
    const resultPath = join(root, '.xvant-result-' + input.attemptId + '.txt');
    if (!write && existsSync(resultPath)) throw new Error('RESULT_EXISTS');
    let session = 'pending:' + input.connectionId;
    if (resumeFromConnectionId) {
      const previous = this.store.providers.get(resumeFromConnectionId);
      const priorTask = this.store.getTask(previous.taskId);
      if (
        previous.status !== 'accepted' ||
        previous.classification !== 'live' ||
        previous.worker.runtimeKind !== 'opencode' ||
        previous.worker.runtimeVersion !== OPENCODE_CLI_VERSION ||
        previous.worker.hostId !== input.worker.hostId ||
        previous.worker.quotaGroupId !== input.worker.quotaGroupId ||
        previous.workspaceId !== input.workspaceId ||
        priorTask.projectId !== task.projectId ||
        previous.verification?.status !== 'passed' ||
        previous.verification.evidence.workspaceRootHash !==
          createHash('sha256').update(safePath(root)).digest('hex')
      )
        throw new Error('RESUME_UNVERIFIED');
      session = previous.worker.nativeSessionId;
    }
    this.busy = true;
    try {
      const inventory = await this.supervisor.start({
        executable: this.options.executable,
        args: [...this.options.prefixArgs!, '--version'],
        cwd: root,
        workerId: input.worker.id,
        attemptId: input.attemptId,
        generation: 1,
        timeoutMs: 10000,
        maxOutputBytes: 16384,
        userApprovedTrustedLocal: true,
      }).result;
      if (
        inventory.reason !== 'exited' ||
        inventory.exitCode !== 0 ||
        inventory.outputTruncated ||
        inventory.stdout.trim() !== 'opencode v' + OPENCODE_CLI_VERSION
      )
        throw new Error('VERSION_UNSUPPORTED');
      if (this.stopped) throw new Error('CONTROLLER_STOPPED');
      const connection = this.store.providers.reserve({
        ...input,
        worker: { ...input.worker, nativeSessionId: session },
      });
      const id = connection.connectionId,
        token = connection.token;
      const heartbeat = setInterval(() => {
        try {
          this.store.heartbeat();
        } catch {
          this.stop();
        }
      }, this.store.heartbeatIntervalMs);
      heartbeat.unref();
      let run: ReturnType<WorkerSupervisor['start']> | undefined;
      let interrupted = false,
        failed = false;
      let stream: OpenCodeCliStream;
      let toolStream: OpenCodeRunStream | undefined;
      let final: { text: string; tokens: number | null } = {
        text: '',
        tokens: null,
      };
      const emit = (kind: LiveEvent['kind'], text: string) => {
        try {
          this.options.onEvent?.({ connectionId: id, kind, text });
        } catch {
          /* Observers cannot affect execution. */
        }
      };
      const recordFailure = () => {
        const failure = toolStream ? toolStream.failed : stream?.failure;
        if (failure && !interrupted)
          this.store.providers.recordFailure(id, token, failure);
      };
      const unknown = () => {
        try {
          this.store.providers.unknown(id, token);
        } catch {
          /* A new owner retains reservations. */
        }
      };
      try {
        this.options.fault?.('live.after_reserve');
        if (!resumeFromConnectionId) {
          const createArgs = [
            ...this.options.prefixArgs!,
            'api',
            '--standalone',
            '--data',
            JSON.stringify({
              title: 'XVANT ' + input.taskId,
              model: { id: 'big-pickle', providerID: 'opencode' },
            }),
            'session.create',
          ];
          this.store.providers.recordIntent(id, token, {
            id: 1,
            method: 'session/create',
            frame: JSON.stringify({ args: createArgs }),
          });
          this.store.providers.assertWritable(id, token);
          if (this.stopped) throw new Error('CONTROLLER_STOPPED');
          run = this.supervisor.start({
            executable: this.options.executable,
            args: createArgs,
            cwd: root,
            workerId: input.worker.id,
            attemptId: input.attemptId,
            generation: connection.generation,
            timeoutMs: this.options.timeoutMs!,
            maxOutputBytes: 65536,
            userApprovedTrustedLocal: true,
          });
          const created = await run.result;
          if (
            created.reason !== 'exited' ||
            created.exitCode !== 0 ||
            created.outputTruncated ||
            this.stopped
          )
            throw new Error('OPERATION_UNKNOWN');
          const reply = JSON.parse(created.stdout);
          if (
            typeof reply?.data?.id !== 'string' ||
            !/^ses_[A-Za-z0-9]+$/.test(reply.data.id) ||
            typeof reply.data.location?.directory !== 'string' ||
            safePath(reply.data.location.directory) !== safePath(root) ||
            reply.data.parentID ||
            reply.data.fork ||
            (reply.data.model &&
              (reply.data.model.id !== 'big-pickle' ||
                reply.data.model.providerID !== 'opencode'))
          )
            throw new Error('SESSION_MISMATCH');
          this.store.providers.recordMessage(id, token, reply);
          this.store.providers.bindSession(id, token, reply.data.id);
          session = reply.data.id;
          this.options.fault?.('live.after_session');
        }
        stream = new OpenCodeCliStream(session, (message) =>
          this.store.providers.recordMessage(id, token, message),
        );
        if (write) toolStream = new OpenCodeRunStream(session);
        const args = [
          ...this.options.prefixArgs!,
          'run',
          '--standalone',
          '--model',
          'opencode/big-pickle',
          '--session',
          session,
          '--format',
          'json',
          '--title',
          'XVANT ' + input.taskId,
          '--',
          task.objective,
        ];
        this.store.providers.recordIntent(id, token, {
          id: resumeFromConnectionId ? 1 : 2,
          method: 'opencode/cli-run',
          frame: JSON.stringify({
            executable: this.options.executable,
            args,
            resultFile: write
              ? null
              : '.xvant-result-' + input.attemptId + '.txt',
            profile: write ? 'workspace-write' : 'text',
            resumeFromConnectionId: resumeFromConnectionId ?? null,
          }),
        });
        this.options.fault?.('live.after_intent');
        this.store.providers.assertWritable(id, token);
        if (this.stopped) throw new Error('CONTROLLER_STOPPED');
        run = this.supervisor.start({
          executable: this.options.executable,
          args,
          cwd: root,
          workerId: input.worker.id,
          attemptId: input.attemptId,
          generation: connection.generation,
          timeoutMs: this.options.timeoutMs!,
          maxOutputBytes: 1048576,
          userApprovedTrustedLocal: true,
          ...(write
            ? {
                env: {
                  OPENCODE_CONFIG_CONTENT: writeConfig(this.options.mcp),
                },
              }
            : {}),
          interactive: {
            retainStdout: !write,
            onStdout: (bytes) => {
              try {
                if (toolStream) {
                  const { frames, signals } = toolStream.receive(bytes);
                  for (const frame of frames)
                    this.store.providers.recordMessage(id, token, frame);
                  for (const signal of signals) emit(signal.kind, signal.text);
                } else stream.receive(bytes);
                recordFailure();
              } catch {
                failed = true;
                try {
                  recordFailure();
                } catch {
                  /* Ownership fencing wins. */
                }
                unknown();
                if (run) this.supervisor.cancel(run.identity);
              }
            },
          },
        });
        run.endInput();
        this.interrupts.set(id, (actor) => {
          if (interrupted) return { status: 'already_requested' };
          this.store.providers.requestInterrupt(id, token, actor);
          interrupted = true;
          this.options.fault?.('live.after_interrupt');
          this.supervisor.cancel(run!.identity);
          return { status: 'requested' };
        });
        this.options.fault?.('live.after_launch');
        const stopped = await run.result;
        this.interrupts.delete(id);
        this.options.fault?.('live.after_shutdown');
        if (
          write &&
          interrupted &&
          !failed &&
          !this.stopped &&
          stopped.reason === 'cancelled'
        ) {
          // `run` owns its turn in-process; once it is gone the turn cannot continue.
          const runId = 'interrupted:' + input.attemptId;
          this.store.providers.bindRun(id, token, runId);
          this.store.providers.finish(id, token, runId, 'cancelled');
          return {
            task: this.store.getTask(input.taskId),
            finalText: '',
            tokens: null,
            auth: { mode: 'opencode-free', plan: input.liveApproval.model },
          };
        }
        if (
          failed ||
          interrupted ||
          this.stopped ||
          stopped.reason !== 'exited' ||
          (!write && stopped.outputTruncated)
        )
          throw new Error('OPERATION_UNKNOWN');
        const result = toolStream ? toolStream.end() : stream.end();
        final = {
          text: result.text,
          tokens: 'tokens' in result ? result.tokens : null,
        };
        if (result.kind === 'failed' && result.failure)
          this.store.providers.recordFailure(id, token, result.failure);
        if (!result.nativeMessageId) throw new Error('OPERATION_UNKNOWN');
        if (result.kind === 'completed' && stopped.exitCode !== 0)
          throw new Error('OPERATION_UNKNOWN');
        this.store.providers.assertWritable(id, token);
        if (result.kind === 'completed' && !write)
          writeFileSync(resultPath, result.text, { flag: 'wx' });
        this.store.providers.bindRun(id, token, result.nativeMessageId);
        this.store.providers.finish(
          id,
          token,
          result.nativeMessageId,
          result.kind,
        );
        if (result.kind === 'completed') {
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
        clearInterval(heartbeat);
      }
      return {
        task: this.store.getTask(input.taskId),
        finalText: final.text,
        tokens: final.tokens,
        auth: { mode: 'opencode-free', plan: input.liveApproval.model },
      };
    } finally {
      this.busy = false;
    }
  }
  stop() {
    this.stopped = true;
    this.supervisor.stopAll();
    this.verifier.stop();
  }
}
