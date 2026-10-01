import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../../packages/storage/src/store.ts';
import type { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { NATIVE_LOCAL_ROUTE } from '../../../packages/contracts/src/live.ts';
import { ToolRegistry } from '../../../packages/tools/src/registry.ts';
import { fileApplyPatch, fileRead } from '../../../packages/tools/src/files.ts';
import {
  gitInspect,
  repoSearch,
} from '../../../packages/tools/src/repository.ts';
import { createProcessTools } from '../../../packages/tools/src/process.ts';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import type { ModelProvider } from '../../../packages/native-agent/src/model.ts';
import {
  runNativeLoop,
  type LoopEvent,
  type LoopLimits,
  type LoopOutcome,
} from '../../../packages/native-agent/src/loop.ts';
import { NativeVerifier } from './native-verifier.ts';
import { NativeReviewController } from './native-review.ts';
import { settleTurn } from './turn-runner.ts';
import type {
  TurnOutcome,
  TurnRequest,
  TurnRunner,
  WorkerSpec,
} from './orchestrator.ts';

/** XVANT's own tools offered to the model. `command.run` needs per-action approval, so it is not. */
const CATALOG = [
  'file.read',
  'file.apply_patch',
  'repo.search',
  'git.inspect',
  'test.run',
];

/**
 * Runs orchestrator turns through XVANT's own model/tool loop under the
 * `native-local` identity, on the same provider lifecycle as the external
 * runtimes: reserve, run, finish, host verification, host-actor acceptance.
 * Every tool call goes through the registry and its receipt is journaled in
 * the connection's fenced ownership, so receipts survive a restart.
 * A real local model is a `live` classification; deterministic stubs are
 * `offline` and never qualify the live route.
 */
export class NativeTurnRunner implements TurnRunner {
  readonly #store: Store;
  readonly #objects: ArtifactStore;
  readonly #workers: Map<string, WorkerSpec>;
  readonly #provider: ModelProvider;
  readonly #classification: 'offline' | 'live';
  readonly #limits: Partial<LoopLimits>;
  readonly #checkTimeoutMs: number;
  readonly #stateDir: string | undefined;
  readonly #onEvent: (alias: string, taskId: string, event: LoopEvent) => void;
  readonly #review: NativeReviewController;
  readonly #active = new Map<string, AbortController>();
  constructor(
    store: Store,
    objects: ArtifactStore,
    workers: WorkerSpec[],
    provider: ModelProvider,
    options: {
      classification: 'offline' | 'live';
      limits?: Partial<LoopLimits>;
      checkTimeoutMs?: number;
      /** Where loop checkpoints are written, one file per turn. */
      stateDir?: string;
      onEvent?: (alias: string, taskId: string, event: LoopEvent) => void;
    },
  ) {
    this.#store = store;
    this.#objects = objects;
    this.#workers = new Map(
      workers
        .filter((w) => w.runtimeKind === 'native-local')
        .map((w) => [w.alias, w]),
    );
    this.#provider = provider;
    this.#classification = options.classification;
    this.#limits = options.limits ?? {};
    this.#checkTimeoutMs = options.checkTimeoutMs ?? 10 * 60 * 1000;
    this.#stateDir = options.stateDir;
    this.#onEvent = options.onEvent ?? (() => {});
    this.#review = new NativeReviewController(store, objects);
  }
  interrupt(taskId: string): boolean {
    const controller = this.#active.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
  #checkpoint(taskId: string, value: unknown): void {
    if (!this.#stateDir) return;
    mkdirSync(this.#stateDir, { recursive: true });
    const path = join(this.#stateDir, taskId + '.checkpoint.json');
    const temp = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
    renameSync(temp, path);
  }
  async run(request: TurnRequest): Promise<TurnOutcome> {
    const worker = this.#workers.get(request.alias);
    if (!worker) throw new Error('NOT_FOUND');
    const store = this.#store;
    const title =
      request.prompt.split('\n').find((l) => l.trim()) ?? request.taskId;
    store.create('create-' + request.taskId, {
      id: request.taskId,
      projectId: request.projectId,
      objective: title.slice(0, 500),
      requiredCheckIds: Object.keys(request.checks),
      acceptanceCriteria: ['Registered checks pass on the worker result'],
    });
    store.queue('queue-' + request.taskId, request.taskId, 0);
    const id = request.taskId;
    const workspaceId = request.taskId;
    const attemptId = request.taskId + '-a1';
    const root = realpathSync(request.workspace.path);
    const verifier = new NativeVerifier(
      store,
      this.#objects,
      { [workspaceId]: root },
      request.checks,
      {
        timeoutMs: this.#checkTimeoutMs,
        gitBases: { [workspaceId]: request.workspace.baseCommit },
        maxCheckOutputBytes: 1048576,
      },
    );
    const live = this.#classification === 'live';
    const connection = store.providers.reserve({
      connectionId: id,
      taskId: request.taskId,
      attemptId,
      workspaceId,
      expectedVersion: store.getTask(request.taskId).rowVersion,
      classification: this.#classification,
      ...(live
        ? {
            liveApproval: {
              actorId: 'xvant-orchestrator',
              model: this.#provider.model,
              transport: NATIVE_LOCAL_ROUTE.transport,
              userApprovedTrustedLocal: true as const,
              profile: 'workspace-write' as const,
            },
          }
        : {}),
      worker: {
        id: request.alias,
        alias: request.alias,
        runtimeKind: 'native-local' as const,
        hostId: 'local',
        endpointId: NATIVE_LOCAL_ROUTE.transport,
        nativeSessionId: randomUUID(),
        runtimeVersion: NATIVE_LOCAL_ROUTE.runtimeVersion,
        adapterVersion: NATIVE_LOCAL_ROUTE.adapterVersion,
        mode: 'managed' as const,
        quotaGroupId: worker.quotaGroupId,
      },
    });
    const token = connection.token;
    const heartbeat = setInterval(() => {
      try {
        store.heartbeat();
      } catch {
        this.#active.get(id)?.abort();
      }
    }, store.heartbeatIntervalMs);
    heartbeat.unref();
    const supervisor = new WorkerSupervisor();
    const abort = new AbortController();
    this.#active.set(id, abort);
    let finalText = '';
    try {
      const runId = randomUUID();
      store.providers.bindRun(id, token, runId);
      const registry = new ToolRegistry(
        [
          fileRead,
          fileApplyPatch,
          repoSearch,
          gitInspect,
          ...createProcessTools({
            supervisor,
            testCommands: Object.entries(request.checks).map(
              ([checkId, check]) => ({
                id: checkId,
                program: check.executable,
                args: check.args,
                timeoutMs: this.#checkTimeoutMs,
              }),
            ),
          }),
        ],
        {
          // A lost fence throws here, which stops the loop: fail closed.
          record: (receipt) =>
            store.providers.recordToolReceipt(id, token, receipt),
        },
      );
      let outcome: LoopOutcome;
      try {
        outcome = await runNativeLoop({
          provider: this.#provider,
          registry,
          context: {
            projectId: request.projectId,
            taskId: request.taskId,
            attemptId,
            workerId: request.alias,
            permissionProfile: 'trusted-local',
            allowedTools: CATALOG,
            approvals: [],
            now: () => Date.now(),
            workspace: {
              root,
              writablePaths: request.writablePaths?.length
                ? request.writablePaths
                : ['.'],
              baseRevision: request.workspace.baseCommit,
            },
          },
          task: request.prompt,
          instructions:
            'Registered checks you can run with test.run: ' +
            (Object.keys(request.checks).join(', ') || 'none') +
            '. To edit a file, read it first and pass its hash as expectedHash; use expectedHash null for a new file.',
          limits: this.#limits,
          signal: abort.signal,
          onCheckpoint: (checkpoint) => this.#checkpoint(id, checkpoint),
          onEvent: (event) => {
            try {
              this.#onEvent(request.alias, request.taskId, event);
            } catch {
              /* Observers cannot affect execution. */
            }
          },
        });
      } catch {
        store.providers.unknown(id, token);
        return settleTurn(store, this.#objects, this.#review, id, '', {});
      }
      finalText = outcome.finalText;
      if (outcome.status === 'completed') {
        store.providers.finish(id, token, runId, 'completed');
        const checked = await verifier.verify(id, token, { stopped: true });
        if (checked.status === 'passed')
          this.#review.prepare(
            id,
            id,
            store.getTask(request.taskId).rowVersion,
          );
      } else if (outcome.status === 'cancelled') {
        store.providers.finish(id, token, runId, 'cancelled');
      } else {
        const model = /^MODEL_[A-Z_]+/.exec(outcome.failure ?? '')?.[0];
        store.providers.recordFailure(id, token, {
          code:
            model === 'MODEL_UNAVAILABLE'
              ? 'MODEL_UNAVAILABLE'
              : 'WORKER_FAILED',
          scope: 'attempt',
          native: (model ?? outcome.status).toLowerCase(),
        });
        store.providers.finish(id, token, runId, 'failed');
      }
    } finally {
      this.#active.delete(id);
      clearInterval(heartbeat);
      supervisor.stopAll();
      verifier.stop();
    }
    return settleTurn(
      store,
      this.#objects,
      this.#review,
      id,
      finalText,
      verifier.checkOutput(id),
    );
  }
}
