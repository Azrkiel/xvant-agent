import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from '../../../packages/storage/src/store.ts';
import type {
  ProviderDispatch,
  ProviderConnection,
} from '../../../packages/storage/src/providers.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import { NativeStream } from '../../../packages/adapters/src/providers/native-stream.ts';
import { NativeLifecycle } from '../../../packages/adapters/src/providers/native-lifecycle.ts';
import {
  buildClaudeLaunch,
  type ClaudeLaunchOptions,
} from '../../../packages/adapters/src/providers/claude-launch.ts';
import {
  versions,
  type StreamKind,
} from '../../../packages/adapters/src/providers/native-profiles.ts';
import { NativeVerifier } from './native-verifier.ts';
import { NativeReviewController } from './native-review.ts';

const scenarioSchema = z.enum([
  'success',
  'permission',
  'wrong-session',
  'malformed',
  'partial',
  'error',
  'timeout',
  'setup-error',
  'setup-mismatch',
  'setup-timeout',
  'interrupt',
  'interrupt-error',
  'interrupt-mismatch',
  'interrupt-timeout',
  'interrupt-partial',
  'interrupt-result-first',
  'interrupt-ack-only',
  'interrupt-unsupported',
  'create-malformed',
  'create-reused',
  'create-permission',
  'create-partial',
  'launch-error',
  'launch-timeout',
]);
type Checks = Record<string, { executable: string; args: readonly string[] }>;
export interface InterruptAdmission {
  status: 'requested' | 'already_requested';
}
/** Fixed synthetic peers only. OpenCode HTTP descriptors travel over fixture pipes. */
export class OfflineNativeController {
  private readonly store: Store;
  private readonly workspaces: Record<string, string>;
  private readonly checks: Checks;
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
    checks: Checks,
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
   * Host-only admission of a native interrupt for a turn this controller owns.
   * Admission commits before the frame is journaled and written. `cancelled`
   * still requires a correlated acknowledgement, terminal output and owned
   * shutdown; otherwise the run stays unknown. Never exposed to providers.
   */
  interrupt(connectionId: string, actorId: string): InterruptAdmission {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    const admit = this.interrupts.get(connectionId);
    if (!admit) throw new Error('NOT_FOUND');
    return admit(actorId);
  }
  async run(
    input: ProviderDispatch,
    scenarioInput = 'success',
    modeInput: 'resume' | 'create' = 'resume',
  ) {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    const scenario = scenarioSchema.parse(scenarioInput);
    const mode = z.enum(['resume', 'create']).parse(modeInput);
    const kind = input.worker.runtimeKind;
    if (
      (kind !== 'claude' && kind !== 'opencode') ||
      input.worker.runtimeVersion !== versions[kind]
    )
      throw new Error('VERSION_UNSUPPORTED');
    const root = this.workspaces[input.workspaceId];
    if (!Object.hasOwn(this.workspaces, input.workspaceId) || !root)
      throw new Error('WORKSPACE_UNAVAILABLE');
    const launch =
      kind === 'claude'
        ? buildClaudeLaunch(mode, input.worker.nativeSessionId, root)
        : undefined;
    if (
      this.store
        .getTask(input.taskId)
        .requiredCheckIds.some((id) => !Object.hasOwn(this.checks, id))
    )
      throw new Error('VERIFIER_UNAVAILABLE');
    const connection = this.store.providers.reserve(
      mode === 'create' && kind === 'opencode'
        ? {
            ...input,
            worker: {
              ...input.worker,
              nativeSessionId: 'pending:' + input.connectionId,
            },
          }
        : input,
    );
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat();
      } catch {
        this.stop();
      }
    }, this.store.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      return await this.execute(connection, kind, scenario, root, mode, launch);
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async execute(
    connection: ProviderConnection,
    kind: StreamKind,
    scenario: string,
    root: string,
    mode: 'resume' | 'create',
    launch: ClaudeLaunchOptions | undefined,
  ) {
    const id = connection.connectionId,
      token = connection.token;
    const life = new NativeLifecycle(
      kind,
      connection.worker.nativeSessionId,
      connection.attemptId,
      root,
      kind === 'claude' ? 'resume' : mode,
    );
    let dispatched = false,
      interruptRequested = false,
      interruptible = false,
      interruptRecorded = false;
    let sessionBound = false;
    const stream = new NativeStream(
      kind,
      connection.worker.runtimeVersion,
      connection.worker.nativeSessionId,
      connection.attemptId,
      {
        beforeReceive: (message) => {
          this.store.providers.recordMessage(id, token, message);
        },
        handleControl: (message) => {
          const handled = life.receive(message);
          if (
            mode === 'create' &&
            kind === 'opencode' &&
            life.ready &&
            !sessionBound
          ) {
            this.store.providers.bindSession(id, token, life.nativeSessionId);
            stream.bindSession(life.nativeSessionId);
            sessionBound = true;
            this.fault('native.after_session');
          }
          return handled;
        },
      },
    );
    let run: ReturnType<WorkerSupervisor['start']> | undefined;
    let writes = Promise.resolve(),
      failed = false,
      sequence = 0;
    const fail = () => {
      failed = true;
      stream.cancel();
      try {
        this.store.providers.unknown(id, token);
      } catch {
        /* Recovery retains the reservation if fenced. */
      }
      if (run) this.supervisor.cancel(run.identity);
    };
    const persist = (method: string, wire: unknown) => {
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      const frame = JSON.stringify(wire) + '\n';
      // Journal IDs label host sends, not vendor JSON-RPC IDs.
      this.store.providers.recordIntent(id, token, {
        id: ++sequence,
        method,
        frame,
      });
      this.store.providers.assertWritable(id, token);
      return frame;
    };
    const write = async (method: string, wire: unknown) => {
      if (!run) throw new Error('OPERATION_UNKNOWN');
      await run.write(persist(method, wire));
    };
    const observeInterruptible = () => {
      if (!interruptible && life.interruptSupport === 'ready') {
        interruptible = true;
        this.fault('native.interruptible');
      }
    };
    this.interrupts.set(id, (actorId) => {
      if (interruptRequested) return { status: 'already_requested' };
      const support = life.interruptSupport;
      if (support === 'unsupported') throw new Error('CAPABILITY_UNSUPPORTED');
      if (failed || support !== 'ready' || stream.status !== 'running')
        throw new Error('NOT_INTERRUPTIBLE');
      this.store.providers.requestInterrupt(id, token, actorId);
      interruptRequested = true;
      this.fault('native.after_interrupt_request');
      // Serialize behind earlier sends so journal order matches pipe order.
      writes = writes.then(() => write('fixture/interrupt', life.interrupt()));
      void writes.catch(fail);
      return { status: 'requested' };
    });
    try {
      this.fault('native.after_reserve');
      if (launch) {
        persist('fixture/claude-launch', {
          fixture: 'claude-launch',
          options: launch,
        });
        this.fault('native.before_launch');
      }
      if (this.stopped) throw new Error('CONTROLLER_STOPPED');
      this.store.providers.assertWritable(id, token);
      run = this.supervisor.start({
        executable: process.execPath,
        args: [
          fileURLToPath(
            new URL('../../../tests/fixtures/native-peer.mjs', import.meta.url),
          ),
          kind,
          scenario,
          connection.worker.nativeSessionId,
          connection.attemptId,
          ...(launch ? [JSON.stringify(launch)] : []),
        ],
        cwd: root,
        workerId: connection.worker.id,
        attemptId: connection.attemptId,
        generation: connection.generation,
        timeoutMs: this.timeout,
        maxOutputBytes: 1048576,
        userApprovedTrustedLocal: true,
        interactive: {
          onStdout: (bytes) => {
            try {
              for (const action of stream.receive(bytes)) {
                writes = writes.then(async () => {
                  await write('fixture/permission-denial', action.wire);
                  stream.denialWritten(action.requestId);
                });
              }
              observeInterruptible();
              if (life.interrupted && !interruptRecorded) {
                interruptRecorded = true;
                this.fault('native.after_interrupt');
              }
              if (life.ready && !dispatched) {
                dispatched = true;
                writes = writes.then(async () => {
                  this.fault('native.after_setup');
                  if (failed || this.stopped)
                    throw new Error('OPERATION_UNKNOWN');
                  life.start();
                  await write('fixture/start', { fixture: 'start' });
                  observeInterruptible();
                });
              }
              if (
                stream.status === 'result_pending' &&
                (!interruptRequested || life.interrupted)
              )
                writes = writes.then(() => {
                  run!.endInput();
                });
              void writes.catch(fail);
            } catch {
              fail();
            }
          },
        },
      });
      if (launch) this.fault('native.after_launch');
      await write(
        mode === 'create' && kind === 'opencode'
          ? 'session/create'
          : 'fixture/setup',
        life.setup(),
      );
      const stopped = await run.result;
      await writes;
      if (
        failed ||
        this.stopped ||
        stopped.reason !== 'exited' ||
        stopped.exitCode !== 0 ||
        stopped.outputTruncated
      )
        throw new Error('OPERATION_UNKNOWN');
      const result = stream.end();
      if (interruptRequested && !life.interrupted)
        throw new Error('OPERATION_UNKNOWN');
      this.fault('native.after_shutdown');
      if (this.stopped) throw new Error('CONTROLLER_STOPPED');
      // These SDK streams expose terminal message identity, not a Codex-style turn ID.
      // The shared evidence slot binds that message; attemptId separately binds the host request.
      this.store.providers.bindRun(id, token, result.nativeMessageId);
      this.store.providers.finish(
        id,
        token,
        result.nativeMessageId,
        interruptRequested ? 'cancelled' : result.kind,
      );
      if (result.kind === 'completed' && !interruptRequested) {
        const verification = await this.verifier.verify(id, token, {
          stopped: true,
        });
        if (verification.status === 'passed' && !this.stopped) {
          this.fault('native.before_review');
          if (this.stopped) throw new Error('CONTROLLER_STOPPED');
          this.review.prepare(
            id,
            id,
            this.store.getTask(connection.taskId).rowVersion,
          );
        }
      }
    } catch {
      fail();
    } finally {
      this.interrupts.delete(id);
      stream.cancel();
      if (run) {
        if (failed) this.supervisor.cancel(run.identity);
        await run.result;
      }
      await writes.catch(() => {});
    }
    return this.store.getTask(connection.taskId);
  }
  stop(): void {
    this.stopped = true;
    this.supervisor.stopAll();
    this.verifier.stop();
  }
}
