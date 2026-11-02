import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Store } from '../../../packages/storage/src/store.ts';
import type { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { lessonScope } from '../../../packages/storage/src/lesson-scope.ts';
import { LIVE_ROUTES } from '../../../packages/contracts/src/live.ts';
import { ToolRegistry } from '../../../packages/tools/src/registry.ts';
import { createControllerTools } from '../../../packages/tools/src/controller.ts';
import { startMcpBridge } from '../../../packages/tools/src/mcp.ts';
import { NativeReviewController } from './native-review.ts';
import { LiveCodexController, type LiveEvent } from './codex-live.ts';
import { LiveClaudeController } from './claude-live.ts';
import { LiveOpenCodeController } from './opencode-live.ts';
import type { RosterRuntime } from './live-roster.ts';
import type {
  TurnOutcome,
  TurnRequest,
  TurnRunner,
  WorkerSpec,
} from './orchestrator.ts';

type ExternalKind = Exclude<WorkerSpec['runtimeKind'], 'native-local'>;
type Controller =
  LiveCodexController | LiveClaudeController | LiveOpenCodeController;
/** Controller tools offered to workers: read-only lookups, nothing that writes. */
export const CONTROLLER_READS = ['lessons.search', 'memory.search'];
/**
 * The host picks the lesson scope from the turn's repository; a worker cannot
 * name one. Without a derivable scope the task's project is used (`undefined`).
 */
export function resolveLessonScope(
  request: TurnRequest,
  root: string,
): string | null | undefined {
  if (request.lessonScope !== undefined) return request.lessonScope;
  try {
    return lessonScope(root);
  } catch {
    return undefined;
  }
}
/**
 * Runs orchestrator turns on the live runtimes. Each turn gets its own
 * controller, provider task and worktree; a passing host verification is
 * accepted explicitly by the orchestrator's host actor, recorded as such.
 * The user accepts the combined root result separately.
 */
export class LiveTurnRunner implements TurnRunner {
  readonly #store: Store;
  readonly #objects: ArtifactStore;
  readonly #workers: Map<string, WorkerSpec>;
  readonly #runtimes: Partial<Record<ExternalKind, RosterRuntime>>;
  readonly #native: TurnRunner | undefined;
  readonly #timeoutMs: number;
  readonly #onEvent: (alias: string, taskId: string, event: LiveEvent) => void;
  readonly #active = new Map<string, Controller>();
  readonly #review: NativeReviewController;
  constructor(
    store: Store,
    objects: ArtifactStore,
    workers: WorkerSpec[],
    runtimes: Partial<Record<ExternalKind, RosterRuntime>>,
    options: {
      timeoutMs?: number;
      /** Runs native-local workers' turns (XVANT's own loop). */
      native?: TurnRunner;
      onEvent?: (alias: string, taskId: string, event: LiveEvent) => void;
    } = {},
  ) {
    this.#store = store;
    this.#objects = objects;
    this.#workers = new Map(workers.map((w) => [w.alias, w]));
    this.#runtimes = runtimes;
    this.#native = options.native;
    this.#timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
    this.#onEvent = options.onEvent ?? (() => {});
    this.#review = new NativeReviewController(store, objects);
  }
  interrupt(taskId: string): boolean {
    const controller = this.#active.get(taskId);
    if (!controller) return this.#native?.interrupt(taskId) ?? false;
    try {
      controller.interrupt(taskId, 'xvant-orchestrator');
      return true;
    } catch {
      controller.stop();
      return true;
    }
  }
  /**
   * The turn's lookups, served over a task-scoped bridge. Learning never fails
   * a run: if the bridge cannot start, the turn goes ahead without these tools.
   */
  async #startSearchBridge(request: TurnRequest) {
    const store = this.#store;
    const id = request.taskId;
    try {
      const scope = resolveLessonScope(
        request,
        realpathSync(request.workspace.path),
      );
      const tools = CONTROLLER_READS.filter(
        (name) => scope !== null || name !== 'lessons.search',
      );
      const registry = new ToolRegistry(
        createControllerTools({
          store,
          objects: this.#objects,
          lessonScopeOf: () => scope,
        }).filter(({ manifest }) => tools.includes(manifest.name)),
        {
          // The controller holds the reservation's token. A lost store owner
          // still fails the generation fence here, so that call errors.
          record: (receipt) =>
            store.providers.recordToolReceipt(
              id,
              store.providers.get(id).token,
              receipt,
            ),
        },
      );
      const bridge = await startMcpBridge({
        registry,
        context: {
          projectId: request.projectId,
          taskId: id,
          attemptId: id + '-a1',
          workerId: request.alias,
          permissionProfile: 'trusted-local',
          allowedTools: tools,
          approvals: [],
          now: () => Date.now(),
        },
      });
      return { bridge, tools };
    } catch {
      try {
        this.#onEvent(request.alias, id, {
          connectionId: id,
          kind: 'activity',
          text: 'search tools unavailable for this turn',
        });
      } catch {
        /* Observers cannot affect execution. */
      }
      return undefined;
    }
  }
  async run(request: TurnRequest): Promise<TurnOutcome> {
    const worker = this.#workers.get(request.alias);
    if (!worker) throw new Error('NOT_FOUND');
    if (worker.runtimeKind === 'native-local') {
      if (!this.#native) throw new Error('RUNTIME_UNAVAILABLE');
      return this.#native.run(request);
    }
    const runtime = this.#runtimes[worker.runtimeKind];
    if (!runtime) throw new Error('RUNTIME_UNAVAILABLE');
    const route = LIVE_ROUTES[worker.runtimeKind];
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
    const workspaceId = request.taskId;
    const common = {
      executable: runtime.executable,
      prefixArgs: runtime.prefixArgs ?? [],
      timeoutMs: this.#timeoutMs,
      gitBases: { [workspaceId]: request.workspace.baseCommit },
      onEvent: (event: LiveEvent) =>
        this.#onEvent(request.alias, request.taskId, event),
    };
    const workspaces = { [workspaceId]: request.workspace.path };
    const input = {
      connectionId: request.taskId,
      taskId: request.taskId,
      attemptId: request.taskId + '-a1',
      workspaceId,
      expectedVersion: store.getTask(request.taskId).rowVersion,
      classification: 'live' as const,
      liveApproval: {
        actorId: 'xvant-orchestrator',
        model:
          worker.runtimeKind === 'opencode'
            ? 'opencode/big-pickle'
            : (worker.model ?? runtime.model ?? 'default'),
        transport: route.transport,
        userApprovedTrustedLocal: true as const,
        profile: 'workspace-write' as const,
        acknowledgedNativeBypass: true as const,
      },
      worker: {
        id: request.alias,
        alias: request.alias,
        runtimeKind: worker.runtimeKind,
        hostId: 'local',
        endpointId: route.transport,
        nativeSessionId:
          worker.runtimeKind === 'claude'
            ? randomUUID()
            : 'pending:' + request.taskId,
        runtimeVersion: runtime.version ?? route.runtimeVersion,
        adapterVersion: route.adapterVersion,
        mode: 'managed' as const,
        quotaGroupId: worker.quotaGroupId,
      },
    };
    let controller: Controller;
    let finalText = '';
    const search = await this.#startSearchBridge(request);
    const options = {
      ...common,
      ...(search
        ? {
            mcp: {
              url: search.bridge.url,
              token: search.bridge.token,
              tools: search.tools,
            },
          }
        : {}),
    };
    try {
      if (worker.runtimeKind === 'codex') {
        const c = new LiveCodexController(
          store,
          this.#objects,
          workspaces,
          request.checks,
          options,
        );
        controller = c;
        this.#active.set(request.taskId, c);
        finalText = (await c.run(input, 'create', request.prompt)).finalText;
      } else if (worker.runtimeKind === 'claude') {
        const c = new LiveClaudeController(
          store,
          this.#objects,
          workspaces,
          request.checks,
          options,
        );
        controller = c;
        this.#active.set(request.taskId, c);
        finalText = (await c.run(input, 'create', request.prompt)).finalText;
      } else {
        const c = new LiveOpenCodeController(
          store,
          this.#objects,
          workspaces,
          request.checks,
          options,
        );
        controller = c;
        this.#active.set(request.taskId, c);
        finalText = (await c.runLive(input, undefined, request.prompt))
          .finalText;
      }
    } finally {
      this.#active.delete(request.taskId);
      await search?.bridge.close();
    }
    const checkOutput = controller.checkOutput(request.taskId);
    controller.stop();
    return settleTurn(
      store,
      this.#objects,
      this.#review,
      request.taskId,
      finalText,
      checkOutput,
    );
  }
}

/**
 * The host-verified outcome of a finished provider turn. A turn whose checks
 * passed is accepted here by the orchestrator's host actor, recorded as such;
 * the user accepts the combined root result separately.
 */
export function settleTurn(
  store: Store,
  objects: ArtifactStore,
  review: NativeReviewController,
  taskId: string,
  finalText: string,
  checkOutput: Record<string, string>,
): TurnOutcome {
  const saved = store.providers.get(taskId);
  const task = store.getTask(taskId);
  let patch: Buffer | null = null;
  let files: string[] = [];
  if (saved.verification && saved.verification.status !== 'unknown') {
    const manifest = JSON.parse(
      objects.get(saved.verification.evidence.treeHash).toString(),
    ) as { patch: string; files: { path: string }[] };
    patch = objects.get(manifest.patch);
    files = manifest.files.map((f) => f.path);
  }
  if (task.state === 'ready_for_acceptance') {
    const prepared = store.lastEvent(taskId, 'native.ready_for_acceptance')
      ?.payload as
      | { connectionId: string; rowVersion: number; evidenceHash: string }
      | undefined;
    if (prepared?.connectionId !== taskId) throw new Error('NOT_FOUND');
    review.accept('accept-' + taskId, {
      connectionId: taskId,
      expectedVersion: prepared.rowVersion,
      reviewedEvidenceHash: prepared.evidenceHash,
      actorId: 'xvant-orchestrator',
      classification: saved.classification,
    });
    return { status: 'accepted', finalText, patch, files };
  }
  const failure = saved.failure
    ? saved.failure.code + ':' + saved.failure.native
    : saved.verification?.status === 'failed'
      ? [
          'Checks failed: ' +
            saved.verification.evidence.receipts
              .filter((r) => r.status === 'failed')
              .map((r) => r.checkId)
              .join(', '),
          ...Object.entries(checkOutput).flatMap(([id, output]) => [
            '',
            '### Output of ' + id,
            output,
          ]),
        ].join('\n')
      : undefined;
  const status: TurnOutcome['status'] =
    saved.outcome === 'cancelled'
      ? 'cancelled'
      : saved.verification?.status === 'failed'
        ? 'verification_failed'
        : saved.outcome === 'failed'
          ? 'failed'
          : 'unknown';
  // The runner has stopped and awaited the turn's process, so a known
  // terminal outcome is trusted evidence that the work stopped: release the
  // worker, session and workspace for the repair. Unknown keeps them held.
  if (
    status !== 'unknown' &&
    ['result_pending', 'verification_failed'].includes(saved.status)
  )
    store.providers.reconcile(taskId, 'stopped');
  return { status, finalText, patch, files, ...(failure ? { failure } : {}) };
}
