import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store, StorageError } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import {
  DomainError,
  idSchema,
} from '../../../packages/contracts/src/index.ts';
import type { ProviderKind } from '../../../packages/contracts/src/providers.ts';
import {
  discoverRuntime,
  type DiscoveredRuntime,
} from '../../../packages/adapters/src/live/discover.ts';
import {
  Orchestrator,
  type RootState,
  type TurnRunner,
  type WorkerSpec,
} from './orchestrator.ts';
import {
  LiveTurnRunner,
  restoreWorkflowModels,
  workflowRuntimeBindings,
} from './turn-runner.ts';
import { activeRouting, applyRouting } from './routing-default.ts';
import type { RosterRuntime } from './live-roster.ts';
import { HttpError, startAppServer, type Asset } from './http/app-server.ts';
import { lessonScope } from '../../../packages/storage/src/lesson-scope.ts';
import { RecoveryBlockedError } from './workflow-recovery.ts';
import { lessonsView } from './lessons-view.ts';
import {
  managerStartSchema,
  observeManagerRun,
  prepareManagerRun,
  type ManagerVerifier,
} from './project-manager.ts';
import { DaemonScheduler } from './daemon-scheduler.ts';
import type { DaemonClock } from './daemon-clock.ts';

const POOL: Record<ProviderKind, [string, WorkerSpec['roles']][]> = {
  codex: [
    ['codex-1', ['planner', 'worker', 'reviewer']],
    ['codex-2', ['worker']],
  ],
  claude: [
    ['claude-1', ['worker', 'reviewer']],
    ['claude-2', ['worker', 'reviewer']],
    ['claude-3', ['worker']],
  ],
  opencode: [1, 2, 3, 4, 5].map((i) => ['opencode-' + i, ['worker']]),
};
const QUOTA: Record<ProviderKind, string> = {
  codex: 'codex-subscription',
  claude: 'claude-subscription',
  opencode: 'opencode-free',
};
/** The standard ten-worker pool, limited to runtimes that qualified. */
export function defaultWorkers(
  qualified: readonly ProviderKind[],
): WorkerSpec[] {
  const workers = qualified.flatMap((kind) =>
    POOL[kind].map(([alias, roles]) => ({
      alias,
      runtimeKind: kind,
      quotaGroupId: QUOTA[kind],
      roles: [...roles],
    })),
  );
  if (workers.length && !workers.some((w) => w.roles.includes('planner')))
    workers[0]!.roles = ['planner', ...workers[0]!.roles];
  return workers;
}
/** A check command the user registered, run by the platform shell. */
export function shellCheck(command: string) {
  return process.platform === 'win32'
    ? {
        executable: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        // cmd /s /c strips one outer pair of quotes and runs the rest as typed.
        args: ['/d', '/s', '/c', '"' + command + '"'],
        windowsVerbatimArguments: true,
      }
    : { executable: '/bin/sh', args: ['-c', command] };
}
const startSchema = z.strictObject({
  commandId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  repository: z.string().trim().min(1).max(1024),
  objective: z.string().trim().min(1).max(20000),
  criteria: z.array(z.string().trim().min(1).max(2000)).max(32).default([]),
  checks: z.array(z.string().trim().min(1).max(2000)).max(16).default([]),
  maxActive: z.number().int().min(1).max(10).default(3),
  review: z.boolean().default(true),
});
const daemonStartSchema = startSchema.extend({
  priority: z.number().int().min(-100).max(100).default(0),
  dueAt: z.number().int().nonnegative().optional(),
  runtimes: z
    .array(z.enum(['codex', 'claude', 'opencode']))
    .min(1)
    .max(3)
    .optional(),
});
const daemonCommandSchema = z.strictObject({ commandId: idSchema });
const daemonResumeSchema = daemonCommandSchema.extend({
  retryAt: z.number().int().nonnegative().optional(),
});
const lifecycleSchema = daemonCommandSchema.extend({
  action: z.enum([
    'pause-intake',
    'pause-dispatch',
    'drain',
    'continue',
    'shutdown',
  ]),
});
const acceptSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  head: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
});
const lessonQuerySchema = z.strictObject({
  repository: z.string().trim().min(1).max(1024),
});
const forgetSchema = lessonQuerySchema.extend({
  id: z.string().regex(/^(ch|sol)_[a-f0-9]{16}$/),
  reason: z.string().trim().min(1).max(500),
});
const webRoot = fileURLToPath(new URL('../public/', import.meta.url));
function loadAssets(): Record<string, Asset> {
  const types: Record<string, string> = {
    '/index.html': 'text/html; charset=utf-8',
    '/app.js': 'text/javascript; charset=utf-8',
    '/app.css': 'text/css; charset=utf-8',
  };
  return Object.fromEntries(
    Object.entries(types).map(([path, type]) => [
      path,
      { type, body: readFileSync(join(webRoot, path.slice(1))) },
    ]),
  );
}

/**
 * The local XVANT application: one Store, runtime discovery, the running
 * orchestrations and the authenticated loopback UI/API. Trusted-local: check
 * commands typed in the UI run on this machine inside XVANT worktrees.
 */
export interface AppOptions {
  home: string;
  port?: number;
  /** Tests inject synthetic runtimes; production discovers installed ones. */
  discover?: (
    kind: ProviderKind,
  ) => DiscoveredRuntime & { prefixArgs?: string[] };
  runner?: (
    store: Store,
    objects: ArtifactStore,
    workers: WorkerSpec[],
    runtimes: Partial<Record<ProviderKind, RosterRuntime>>,
  ) => TurnRunner;
  /** Host-registered offline verifier, available only with an injected runner. */
  managerVerifier?: ManagerVerifier;
  daemon?: {
    operatorToken: string;
    clock: DaemonClock;
    slots: number;
    shutdown: () => void;
    onError: (error: unknown) => void;
  };
}
export async function startApp(options: AppOptions) {
  mkdirSync(options.home, { recursive: true });
  const daemon = options.daemon;
  const store = new Store(join(options.home, 'state.sqlite'), {
    owner: daemon ? 'daemon_' + randomUUID() : 'xvant-app',
    ...(daemon
      ? {
          leaseClock: daemon.clock.host,
          leaseMs: 3_000,
          now: daemon.clock.now,
          recordClock: () => daemon.clock.sample(),
        }
      : {}),
    recoverWorkGraphs: true,
  });
  daemon?.clock.restore(store.schedule.clock());
  let scheduler: DaemonScheduler | undefined;
  const objects = new ArtifactStore(join(options.home, 'objects'));
  const heartbeat = setInterval(() => {
    try {
      if (scheduler) scheduler.pulse();
      else store.heartbeat();
    } catch (error) {
      daemon?.onError(error);
      /* A replaced controller loses its lease; runs record the failure. */
    }
  }, store.heartbeatIntervalMs);
  heartbeat.unref();
  const discover =
    (!daemon || options.runner ? options.discover : undefined) ??
    ((kind) =>
      daemon
        ? {
            runtimeKind: kind,
            status: 'unavailable' as const,
            executable: null,
            version: null,
            expectedVersion: '',
            candidates: 0,
          }
        : discoverRuntime(kind));
  let discovered: (DiscoveredRuntime & { prefixArgs?: string[] })[] = [];
  const refreshRuntimes = () =>
    (discovered = (['codex', 'claude', 'opencode'] as const).map((kind) =>
      discover(kind),
    ));
  try {
    refreshRuntimes();
  } catch (error) {
    clearInterval(heartbeat);
    store.close();
    throw error;
  }
  const active = new Map<
    string,
    {
      orchestrator: Orchestrator;
      workers: WorkerSpec[];
      state: RootState | null;
    }
  >();
  const busy = new Map<string, { rootId: string }>();
  const meta = new Map<string, { repository: string }>();
  const workers = (only?: readonly ProviderKind[]) =>
    defaultWorkers(
      discovered
        .filter(
          (d) =>
            d.status === 'qualified' && (!only || only.includes(d.runtimeKind)),
        )
        .map((d) => d.runtimeKind),
    );

  const availableRuntimes = (): Partial<Record<ProviderKind, RosterRuntime>> =>
    Object.fromEntries(
      discovered
        .filter((d) => d.status === 'qualified')
        .map((d) => [
          d.runtimeKind,
          {
            executable: d.executable!,
            version: d.version!,
            ...(d.prefixArgs ? { prefixArgs: d.prefixArgs } : {}),
          },
        ]),
    );

  const controllerFor = (
    id: string,
    pool: WorkerSpec[],
    runtimes: Partial<Record<ProviderKind, RosterRuntime>>,
    turnTimeoutMs?: number,
  ) => {
    const runner: TurnRunner = options.runner
      ? options.runner(store, objects, pool, runtimes)
      : new LiveTurnRunner(
          store,
          objects,
          pool,
          runtimes,
          turnTimeoutMs === undefined ? {} : { timeoutMs: turnTimeoutMs },
        );
    const tracked: TurnRunner = {
      ...(runner.remoteRecovery
        ? { remoteRecovery: runner.remoteRecovery }
        : {}),
      run: async (request, execution) => {
        busy.set(request.alias, { rootId: id });
        try {
          return await runner.run(request, execution);
        } finally {
          busy.delete(request.alias);
        }
      },
      interrupt: (taskId) => runner.interrupt(taskId),
    };
    return {
      runner: tracked,
      orchestrator: new Orchestrator(store, tracked, pool, {
        stateRoot: join(options.home, 'runs'),
        objects,
        ...(daemon ? { now: daemon.clock.now } : {}),
        runtimeBindings: workflowRuntimeBindings(pool, runtimes),
        ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs }),
        onChange: (state) => {
          if (daemon) store.schedule.progressing(id);
          const entry = active.get(id);
          if (entry) entry.state = state;
        },
      }),
    };
  };
  const start = async (input: z.infer<typeof startSchema>) => {
    const id =
      'r' +
      createHash('sha256').update(input.commandId).digest('hex').slice(0, 20);
    return admit(input, id);
  };
  const admit = (
    input: z.infer<typeof daemonStartSchema> | z.infer<typeof startSchema>,
    id: string,
  ) => {
    // Existing standalone UI callers use the persisted graph identity.
    if (!daemon)
      try {
        store.graphs.get(id);
        return { id, created: false };
      } catch {
        /* new run */
      }
    let repository: string;
    try {
      repository = realpathSync(resolve(input.repository));
      if (!statSync(repository).isDirectory()) throw new Error();
    } catch {
      throw new HttpError(400, 'INVALID_REPOSITORY');
    }
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (top.status !== 0) throw new HttpError(400, 'INVALID_REPOSITORY');
    const pool = workers('runtimes' in input ? input.runtimes : undefined);
    if (!pool.length) throw new HttpError(409, 'NO_RUNTIME');
    const runtimes = availableRuntimes();
    // The promoted routing default, if this state directory recorded one.
    let routing: ReturnType<typeof activeRouting>;
    try {
      routing = activeRouting(options.home);
    } catch {
      // A default that no longer matches its ledger must be repaired, not ignored.
      throw new HttpError(409, 'ROUTING_DEFAULT_INVALID');
    }
    if (routing) applyRouting(pool, runtimes, routing.settings);
    const { orchestrator, runner } = controllerFor(id, pool, runtimes);
    const project = daemon ? lessonScope(repository) : 'app';
    const spec = {
      id,
      projectId: project,
      repository,
      baseRevision: 'HEAD',
      objective: input.objective,
      acceptanceCriteria: input.criteria.length
        ? input.criteria
        : ['The objective is met'],
      checks: Object.fromEntries(
        input.checks.map((c, i) => ['check' + (i + 1), shellCheck(c)]),
      ),
      maxActive: input.maxActive,
      review: input.review,
    };
    if (daemon) {
      if (!store.schedule.control().intake)
        throw new HttpError(409, 'INTAKE_PAUSED');
      if (input.maxActive > daemon.slots)
        throw new HttpError(409, 'WORKER_LIMIT');
      orchestrator.admit(spec);
      const job = queue(
        id,
        project,
        'priority' in input ? input.priority : 0,
        'dueAt' in input ? input.dueAt : undefined,
        runner,
      );
      return { id, created: true, acceptedAt: job.acceptedAt };
    }
    meta.set(id, { repository });
    active.set(id, { orchestrator, workers: pool, state: null });
    return runStandalone(id, orchestrator, spec);
  };
  const runStandalone = async (
    id: string,
    orchestrator: Orchestrator,
    spec: Parameters<Orchestrator['run']>[0],
  ) => {
    void orchestrator.run(spec).finally(() => active.delete(id));
    // Wait until the graph exists so the client can open it immediately.
    for (let i = 0; i < 200; i++) {
      try {
        store.graphs.get(id);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    return { id, created: true };
  };
  const bound = (id: string) => {
    const checkpoint = Orchestrator.checkpoint(store, id);
    const runtimes = availableRuntimes();
    const pool = checkpoint.workers;
    restoreWorkflowModels(runtimes, checkpoint.runtimeBindings);
    return controllerFor(id, pool, runtimes, checkpoint.turnTimeoutMs);
  };
  const resume = async (id: string) => {
    if (active.has(id)) throw new HttpError(409, 'CONFLICT');
    const { orchestrator } = bound(id);
    active.set(id, {
      orchestrator,
      workers: Orchestrator.checkpoint(store, id).workers,
      state: null,
    });
    try {
      const state = await orchestrator.resume(id);
      return { id, phase: state.phase, reason: state.reason ?? null };
    } finally {
      active.delete(id);
    }
  };
  const queue = (
    id: string,
    project: string,
    priority: number,
    dueAt: number | undefined,
    runner: TurnRunner,
  ) => {
    const { spec, workers } = Orchestrator.checkpoint(store, id);
    return store.schedule.add({
      id,
      project,
      priority,
      dueAt: dueAt ?? daemon!.clock.now(),
      slots: spec.maxActive,
      resources: [
        ...new Set([
          'project:' + project,
          ...workers.map(({ alias }) => 'worker:' + alias),
          ...workers.map(({ quotaGroupId }) => 'quota:' + quotaGroupId),
          ...(runner.remoteRecovery
            ? ['remote:' + runner.remoteRecovery.scope]
            : []),
        ]),
      ],
    });
  };
  const enqueueExisting = (id: string, retryAt?: number) => {
    const checkpoint = Orchestrator.checkpoint(store, id);
    const job = store.schedule.get(id);
    if (checkpoint.progress.step === 'done')
      return { id, phase: store.graphs.get<RootState>(id).state.phase };
    if (!store.schedule.control().intake && !job)
      throw new HttpError(409, 'INTAKE_PAUSED');
    if (job) store.schedule.requeue(id, retryAt);
    else
      queue(
        id,
        lessonScope(checkpoint.spec.repository),
        0,
        retryAt,
        bound(id).runner,
      );
    return { id, phase: 'queued' };
  };
  const schedulerCommand = <T>(
    key: string,
    input: unknown,
    run: () => T,
  ): T => {
    let executed = false;
    const result = store.daemonCommand(key, input, () => {
      executed = true;
      return run();
    });
    if (executed) scheduler!.wake();
    return result;
  };
  if (daemon) {
    scheduler = new DaemonScheduler(
      store,
      daemon.clock,
      daemon.slots,
      (id) => bound(id).orchestrator,
      (id) => lessonScope(Orchestrator.checkpoint(store, id).spec.repository),
      daemon.onError,
      (id, state) => {
        const run = store.contracts.managerRun(id);
        if (run) observeManagerRun(store, run, state);
      },
    );
    try {
      scheduler.pulse();
      await scheduler.recover();
    } catch (error) {
      clearInterval(heartbeat);
      store.close();
      throw error;
    }
  }
  const rootView = (id: string) => {
    const record = store.graphs.get<RootState & { repository?: string }>(id);
    const checkpoint = store.workflows.read(id) as {
      progress?: { step?: string };
    } | null;
    const resumable =
      !active.has(id) &&
      (!scheduler ||
        store.schedule.get(id)?.status === 'blocked' ||
        !store.schedule.get(id)) &&
      !!checkpoint?.progress?.step &&
      checkpoint.progress.step !== 'done';
    const latest = new Map(
      store.workflows.recoveries(id).map((entry) => [entry.slot, entry]),
    );
    const recovery = store.workflows.actions(id).flatMap((action) => {
      const entry = latest.get(action.slot);
      return action.status === 'dispatching' &&
        entry?.decision === 'block' &&
        entry.dispatchId === (action.dispatchId ?? null)
        ? [entry]
        : [];
    });
    return {
      id,
      rowVersion: record.rowVersion,
      repository: meta.get(id)?.repository ?? record.state.repository ?? null,
      state: record.state,
      ...(daemon ? { job: store.schedule.get(id) ?? null } : {}),
      ...(resumable ? { resumable: true } : {}),
      ...(recovery.length ? { recovery } : {}),
      events: store.graphs.events(id).slice(-300),
    };
  };
  /**
   * Repositories this app has run work in, each with its lesson scope. Lessons
   * are only ever read through one of these: a client names a repository, never
   * a scope.
   */
  const knownRepositories = () => {
    const found = new Map<string, string>();
    for (const g of store.graphs.list()) {
      const path =
        meta.get(g.id)?.repository ??
        store.graphs.get<RootState & { repository?: string }>(g.id).state
          .repository;
      if (typeof path !== 'string' || found.has(path)) continue;
      try {
        found.set(path, lessonScope(path));
      } catch {
        /* The folder is gone or no longer a repository: no lessons to show. */
      }
    }
    return found;
  };
  const scopeOfKnown = (repository: string) =>
    knownRepositories().get(repository) ??
    (() => {
      throw new HttpError(404, 'UNKNOWN_REPOSITORY');
    })();
  const listening = startAppServer({
    ...(daemon ? { operatorToken: daemon.operatorToken } : {}),
    ...(options.port === undefined ? {} : { port: options.port }),
    assets: loadAssets(),
    toError: (error) => {
      if (error instanceof RecoveryBlockedError)
        return { status: 409, code: error.code, recovery: error.recovery };
      if (error instanceof z.ZodError)
        return { status: 400, code: 'INVALID_INPUT' };
      if (
        error instanceof DomainError ||
        error instanceof StorageError ||
        error instanceof Error
      ) {
        const code = (error as { code?: string }).code ?? error.message;
        if (code === 'NOT_FOUND') return { status: 404, code };
        if (code === 'CONFLICT' || code === 'DUPLICATE_IDENTITY')
          return { status: 409, code };
        if (code === 'POLICY_DENIED') return { status: 403, code };
        const conflict = code.split(':')[0]!;
        if (
          [
            'CHECKPOINT_INVALID',
            'CHECKPOINT_INCOMPLETE',
            'CHECKPOINT_UNAVAILABLE',
            'WORKFLOW_BINDINGS_CHANGED',
            'WORKFLOW_ACTION_INVALID',
            'UNRESOLVED_WORKFLOW_ACTION',
            'STALE_FENCE',
            'SECRET_IN_WORKFLOW_SPEC',
          ].includes(conflict)
        )
          return { status: 409, code: conflict };
        if (code === 'INVALID_INPUT') return { status: 400, code };
      }
      return undefined;
    },
    stream: {
      subscribe: (after, push) => {
        let cursor = after;
        const tick = () => {
          for (const event of store.graphs.allEvents(cursor, 500)) {
            cursor = event.sequence;
            push({
              id: event.sequence,
              data: { graphId: event.graphId, kind: event.kind },
            });
          }
        };
        tick();
        const timer = setInterval(tick, 400);
        return () => clearInterval(timer);
      },
    },
    routes: [
      ...(scheduler
        ? [
            {
              method: 'GET' as const,
              path: /^\/api\/v1\/daemon$/,
              handle: async () => scheduler!.status(),
            },
            {
              method: 'POST' as const,
              path: /^\/api\/v1\/daemon\/control$/,
              handle: async ({ body }: { body: Record<string, unknown> }) => {
                const input = lifecycleSchema.parse(body);
                let shutdown = false;
                const result = schedulerCommand(input.commandId, input, () => {
                  if (input.action !== 'shutdown')
                    return store.schedule.setControl(input.action);
                  shutdown = true;
                  return {
                    stopping: true,
                    generation: store.ownership.generation,
                  };
                });
                if (shutdown) daemon!.shutdown();
                return result;
              },
            },
          ]
        : []),
      {
        method: 'GET',
        path: /^\/api\/v1\/csrf$/,
        handle: async () => ({ csrfToken: server.csrfToken() }),
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/contracts$/,
        handle: async ({ body }) => store.contracts.apply(body),
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/contracts\/projects\/([A-Za-z][A-Za-z0-9_-]{0,63})$/,
        handle: async ({ match }) => store.contracts.getProject(match[1]!),
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/contracts\/projects\/([A-Za-z][A-Za-z0-9_-]{0,63})\/backlog(?:\/([1-9]\d{0,15}))?$/,
        handle: async ({ match }) =>
          store.contracts.getBacklog(
            match[1]!,
            match[2] === undefined ? undefined : Number(match[2]),
          ),
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/contracts\/projects\/([A-Za-z][A-Za-z0-9_-]{0,63})\/manager$/,
        handle: async ({ match }) => {
          const projectId = match[1]!;
          const snapshot = store.contracts.getBacklog(projectId);
          const runs = store.contracts.managerRuns(projectId).map((run) => {
            const job = store.schedule.get(run.rootId);
            const { record, decision } = store.contracts.getTask(run.taskId);
            const current =
              snapshot.status === 'current' &&
              run.revision === snapshot.backlog?.revision;
            let status: string = job?.status ?? 'blocked';
            if (!current) status = 'superseded';
            else if (job?.status === 'done') {
              const accepted =
                record.acceptance?.accepted && decision.readyForHumanReview;
              status =
                accepted && record.acceptance?.request.mode.kind === 'exception'
                  ? 'accepted_exception'
                  : accepted &&
                      decision.checks === 'passed' &&
                      decision.review !== 'blocked'
                    ? 'idle'
                    : decision.readyForHumanReview
                      ? 'awaiting_acceptance'
                      : 'blocked';
            }
            return {
              ...run,
              status,
              job,
              decision,
              acceptance: record.acceptance,
            };
          });
          return { ...snapshot, runs };
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/contracts\/projects\/([A-Za-z][A-Za-z0-9_-]{0,63})\/manager$/,
        handle: async ({ match, body }) => {
          if (!daemon || !scheduler || !options.runner)
            throw new HttpError(409, 'MANAGER_OFFLINE_RUNNER_REQUIRED');
          const projectId = match[1]!;
          const input = managerStartSchema.parse(body);
          return schedulerCommand(
            input.commandId,
            { action: 'manage', projectId, ...input },
            () => {
              if (!store.schedule.control().intake)
                throw new HttpError(409, 'INTAKE_PAUSED');
              if (input.maxActive > daemon.slots)
                throw new HttpError(409, 'WORKER_LIMIT');
              const { spec, run, pool, turnTimeoutMs } = prepareManagerRun(
                store,
                projectId,
                input,
                options.managerVerifier,
                workers(),
              );
              const { orchestrator, runner } = controllerFor(
                run.rootId,
                pool,
                availableRuntimes(),
                turnTimeoutMs,
              );
              orchestrator.admit(spec);
              store.contracts.bindManagerRun(run);
              const { backlog } = store.contracts.getBacklog(projectId);
              const job = queue(
                run.rootId,
                lessonScope(spec.repository),
                Math.max(...backlog!.milestones.map((item) => item.priority)),
                undefined,
                runner,
              );
              return { ...run, acceptedAt: job.acceptedAt };
            },
          );
        },
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/contracts\/tasks\/([A-Za-z][A-Za-z0-9_-]{0,63})$/,
        handle: async ({ match }) => store.contracts.getTask(match[1]!),
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/overview$/,
        handle: async () => ({
          ...(daemon ? { daemon: true } : {}),
          runtimes: discovered.map((d) => ({
            runtimeKind: d.runtimeKind,
            status: d.status,
            version: d.version,
            executable: d.executable,
          })),
          workers: workers().map((w) => ({
            alias: w.alias,
            runtimeKind: w.runtimeKind,
            roles: w.roles,
            state: busy.has(w.alias)
              ? 'running'
              : store.providers.blocked(w.quotaGroupId)
                ? 'blocked'
                : 'idle',
            rootId: busy.get(w.alias)?.rootId ?? null,
          })),
          roots: store.graphs
            .list()
            .reverse()
            .map((g) => {
              const state = store.graphs.get<RootState>(g.id).state;
              return {
                id: g.id,
                objective: state.objective,
                phase: state.phase,
                rowVersion: g.rowVersion,
              };
            }),
        }),
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/lessons\/repositories$/,
        handle: async () => ({
          repositories: [...knownRepositories().keys()].map((path) => ({
            path,
          })),
        }),
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/lessons$/,
        handle: async ({ query }) => {
          const { repository } = lessonQuerySchema.parse({
            repository: query.get('repository'),
          });
          return {
            repository,
            ...lessonsView(store, scopeOfKnown(repository)),
          };
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/lessons\/forget$/,
        handle: async ({ body }) => {
          const { repository, id, reason } = forgetSchema.parse(body);
          const node = store.lessons.forget(
            scopeOfKnown(repository),
            id,
            reason,
          );
          return { id: node.id, forgotten: node.forgotten };
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/runtimes\/refresh$/,
        handle: async () => {
          refreshRuntimes();
          scheduler?.wake();
          return { ok: true };
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/roots$/,
        handle: async ({ body }) => {
          if (!scheduler) return start(startSchema.parse(body));
          const input = daemonStartSchema.parse(body);
          const id =
            'r' +
            createHash('sha256')
              .update(input.commandId)
              .digest('hex')
              .slice(0, 20);
          return schedulerCommand(
            input.commandId,
            { action: 'start', ...input },
            () => admit(input, id),
          );
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/roots\/([A-Za-z][A-Za-z0-9_-]{0,63})\/resume$/,
        handle: async ({ match, body }) => {
          const id = match[1]!;
          if (!scheduler) return resume(id);
          const { commandId, retryAt } = daemonResumeSchema.parse(body);
          return schedulerCommand(
            commandId,
            { action: 'resume', id, retryAt: retryAt ?? null },
            () => enqueueExisting(id, retryAt),
          );
        },
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/roots\/([A-Za-z][A-Za-z0-9_-]{0,63})$/,
        handle: async ({ match }) => rootView(match[1]!),
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/roots\/([A-Za-z][A-Za-z0-9_-]{0,63})\/diff$/,
        handle: async ({ match }) => {
          const state = store.graphs.get<RootState>(match[1]!).state;
          if (!state.integration)
            return { head: null, diff: '', truncated: false };
          const run = spawnSync(
            'git',
            ['diff', state.integration.baseCommit, state.integration.head],
            {
              cwd: state.integration.path,
              encoding: 'utf8',
              maxBuffer: 64 * 1024 * 1024,
              windowsHide: true,
            },
          );
          const diff = run.stdout ?? '';
          const limit = 1024 * 1024;
          return {
            head: state.integration.head,
            diff: diff.slice(0, limit),
            truncated: diff.length > limit,
          };
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/roots\/([A-Za-z][A-Za-z0-9_-]{0,63})\/cancel$/,
        handle: async ({ match, body }) => {
          if (scheduler) {
            const id = match[1]!;
            const { commandId } = daemonCommandSchema.parse(body);
            const result = schedulerCommand(
              commandId,
              { action: 'cancel', id },
              () => {
                scheduler!.cancel(id);
                return { cancelling: true };
              },
            );
            scheduler.signalCancellation(id);
            return result;
          }
          active.get(match[1]!)?.orchestrator.cancel();
          return { cancelling: active.has(match[1]!) };
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/roots\/([A-Za-z][A-Za-z0-9_-]{0,63})\/accept$/,
        handle: async ({ match, body }) => {
          const id = match[1]!;
          const accept = ({
            expectedVersion,
            head,
          }: z.infer<typeof acceptSchema>) => {
            if (store.contracts.managerRun(id))
              throw new HttpError(409, 'USE_CONTRACT_ACCEPTANCE');
            const record = store.graphs.get<RootState>(id);
            // The user accepts exactly what they reviewed: same version and head.
            if (
              record.rowVersion !== expectedVersion ||
              record.state.phase !== 'ready' ||
              record.state.integration?.head !== head
            )
              throw new HttpError(409, 'CONFLICT');
            store.graphs.update(
              id,
              expectedVersion,
              { ...record.state, phase: 'accepted' },
              'graph.accepted',
              { actorId: 'user', head },
            );
            return { branch: record.state.integration.branch, head };
          };
          if (!scheduler) return accept(acceptSchema.parse(body));
          const { commandId, ...input } = acceptSchema
            .extend(daemonCommandSchema.shape)
            .parse(body);
          return schedulerCommand(
            commandId,
            { action: 'accept', id, ...input },
            () => accept(input),
          );
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/stop$/,
        handle: async () => {
          if (scheduler) throw new HttpError(409, 'USE_DAEMON_CONTROL');
          for (const entry of active.values()) entry.orchestrator.cancel();
          return { stopping: active.size };
        },
      },
    ],
  });
  const server: Awaited<ReturnType<typeof startAppServer>> =
    await listening.catch((error: unknown) => {
      clearInterval(heartbeat);
      store.close();
      throw error;
    });
  scheduler?.wake();
  return {
    origin: server.origin,
    bootstrapToken: server.bootstrapToken,
    store,
    close: async () => {
      if (scheduler) await Promise.all([scheduler.close(), server.close()]);
      else {
        for (const entry of active.values()) entry.orchestrator.cancel();
        await server.close();
      }
      clearInterval(heartbeat);
      store.close();
    },
  };
}
