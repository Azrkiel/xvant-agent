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
import { NativeVerifier } from './native-verifier.ts';
import { NativeReviewController } from './native-review.ts';

const scenarioSchema = z.enum([
  'success',
  'approval',
  'interrupt',
  'disconnect',
  'malformed',
  'timeout',
  'late-malformed',
  'late-partial',
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
  async run(input: ProviderDispatch, scenarioInput: string = 'success') {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    const scenario = scenarioSchema.parse(scenarioInput);
    if (
      input.worker.runtimeKind !== 'codex' ||
      input.worker.runtimeVersion !== CODEX_VERSION ||
      input.worker.nativeSessionId !== 'thread-1'
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
    const connection = this.store.providers.reserve(input);
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
      return await this.execute(connection, scenario, root);
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async execute(
    connection: ProviderConnection,
    scenario: string,
    root: string,
  ) {
    const life = new CodexLifecycle(
      CODEX_VERSION,
      connection.worker.nativeSessionId,
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
    const fail = () => {
      failed = true;
      life.disconnected();
      rejectTerminal(new Error('OPERATION_UNKNOWN'));
      try {
        channel.close();
      } catch {
        /* Unknown outcome is retained durably. */
      }
      if (run) this.supervisor.cancel(run.identity);
    };
    const channel = durableCodexChannel(this.store, connection, {
      timeoutMs: this.timeout,
      write: (frame) => run.write(frame),
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
      const start = life.start(this.store.getTask(connection.taskId).objective);
      life.started(await channel.request(start.method, start.params));
      this.store.providers.bindRun(
        connection.connectionId,
        connection.token,
        life.nativeRunId!,
      );
      if (scenario === 'interrupt') {
        const interrupt = life.interrupt();
        validateNative(
          'TurnInterruptResponse',
          await channel.request(interrupt.method, interrupt.params),
        );
      }
      await terminal;
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
