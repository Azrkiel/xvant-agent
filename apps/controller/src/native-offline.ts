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
  'create-malformed',
  'create-reused',
  'create-permission',
  'create-partial',
]);
type Checks = Record<string, { executable: string; args: readonly string[] }>;
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
    if (mode === 'create' && kind !== 'opencode')
      throw new Error('MODE_UNSUPPORTED');
    const root = this.workspaces[input.workspaceId];
    if (!Object.hasOwn(this.workspaces, input.workspaceId) || !root)
      throw new Error('WORKSPACE_UNAVAILABLE');
    if (
      this.store
        .getTask(input.taskId)
        .requiredCheckIds.some((id) => !Object.hasOwn(this.checks, id))
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
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat();
      } catch {
        this.stop();
      }
    }, this.store.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      return await this.execute(connection, kind, scenario, root, mode);
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
  ) {
    const id = connection.connectionId,
      token = connection.token;
    const life = new NativeLifecycle(
      kind,
      connection.worker.nativeSessionId,
      connection.attemptId,
      root,
      mode,
    );
    const wantsInterrupt = scenario.startsWith('interrupt');
    let dispatched = false,
      interruptSent = false,
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
          if (mode === 'create' && life.ready && !sessionBound) {
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
    const write = async (method: string, wire: unknown) => {
      if (failed || this.stopped || !run) throw new Error('OPERATION_UNKNOWN');
      const frame = JSON.stringify(wire) + '\n';
      // Journal IDs label host sends, not vendor JSON-RPC IDs.
      this.store.providers.recordIntent(id, token, {
        id: ++sequence,
        method,
        frame,
      });
      this.store.providers.assertWritable(id, token);
      await run.write(frame);
    };
    try {
      this.fault('native.after_reserve');
      if (this.stopped) throw new Error('CONTROLLER_STOPPED');
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
                  if (wantsInterrupt && kind === 'opencode' && !interruptSent) {
                    interruptSent = true;
                    await write('fixture/interrupt', life.interrupt());
                  }
                });
              }
              if (wantsInterrupt && !interruptSent && life.canInterrupt) {
                interruptSent = true;
                writes = writes.then(() =>
                  write('fixture/interrupt', life.interrupt()),
                );
              }
              if (
                stream.status === 'result_pending' &&
                (!wantsInterrupt || life.interrupted)
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
      await write(
        mode === 'create' ? 'session/create' : 'fixture/setup',
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
      if (wantsInterrupt && !life.interrupted)
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
        wantsInterrupt ? 'cancelled' : result.kind,
      );
      if (result.kind === 'completed' && !wantsInterrupt) {
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
