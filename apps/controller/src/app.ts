import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store, StorageError } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { DomainError } from '../../../packages/contracts/src/index.ts';
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
import { LiveTurnRunner } from './turn-runner.ts';
import { activeRouting, applyRouting } from './routing-default.ts';
import type { RosterRuntime } from './live-roster.ts';
import { HttpError, startAppServer, type Asset } from './http/app-server.ts';

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
const acceptSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  head: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
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
export async function startApp(options: {
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
}) {
  mkdirSync(options.home, { recursive: true });
  const store = new Store(join(options.home, 'state.sqlite'), {
    owner: 'xvant-app',
  });
  const objects = new ArtifactStore(join(options.home, 'objects'));
  const heartbeat = setInterval(() => {
    try {
      store.heartbeat();
    } catch {
      /* A replaced controller loses its lease; runs record the failure. */
    }
  }, store.heartbeatIntervalMs);
  heartbeat.unref();
  const discover = options.discover ?? ((kind) => discoverRuntime(kind));
  let discovered: (DiscoveredRuntime & { prefixArgs?: string[] })[] = [];
  const refreshRuntimes = () =>
    (discovered = (['codex', 'claude', 'opencode'] as const).map((kind) =>
      discover(kind),
    ));
  refreshRuntimes();
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
  const workers = () =>
    defaultWorkers(
      discovered
        .filter((d) => d.status === 'qualified')
        .map((d) => d.runtimeKind),
    );

  const start = async (input: z.infer<typeof startSchema>) => {
    const id =
      'r' +
      createHash('sha256').update(input.commandId).digest('hex').slice(0, 20);
    // The same command ID is the same run: a double submit returns it.
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
    const pool = workers();
    if (!pool.length) throw new HttpError(409, 'NO_RUNTIME');
    const runtimes: Partial<Record<ProviderKind, RosterRuntime>> =
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
    // The promoted routing default, if this state directory recorded one.
    let routing: ReturnType<typeof activeRouting>;
    try {
      routing = activeRouting(options.home);
    } catch {
      // A default that no longer matches its ledger must be repaired, not ignored.
      throw new HttpError(409, 'ROUTING_DEFAULT_INVALID');
    }
    if (routing) applyRouting(pool, runtimes, routing.settings);
    const runner = options.runner
      ? options.runner(store, objects, pool, runtimes)
      : new LiveTurnRunner(store, objects, pool, runtimes);
    // Track which worker is busy on which run, for the roster view.
    const tracked: TurnRunner = {
      run: async (request) => {
        busy.set(request.alias, { rootId: id });
        try {
          return await runner.run(request);
        } finally {
          busy.delete(request.alias);
        }
      },
      interrupt: (taskId) => runner.interrupt(taskId),
    };
    const orchestrator = new Orchestrator(store, tracked, pool, {
      stateRoot: join(options.home, 'runs'),
      onChange: (state) => {
        const entry = active.get(id);
        if (entry) entry.state = state;
      },
    });
    meta.set(id, { repository });
    active.set(id, { orchestrator, workers: pool, state: null });
    void orchestrator
      .run({
        id,
        projectId: 'app',
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
      })
      .finally(() => active.delete(id));
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
  const rootView = (id: string) => {
    const record = store.graphs.get<RootState & { repository?: string }>(id);
    return {
      id,
      rowVersion: record.rowVersion,
      repository: meta.get(id)?.repository ?? record.state.repository ?? null,
      state: record.state,
      events: store.graphs.events(id).slice(-300),
    };
  };
  const server = await startAppServer({
    ...(options.port === undefined ? {} : { port: options.port }),
    assets: loadAssets(),
    toError: (error) => {
      if (error instanceof z.ZodError)
        return { status: 400, code: 'INVALID_INPUT' };
      if (
        error instanceof DomainError ||
        error instanceof StorageError ||
        error instanceof Error
      ) {
        const code = (error as { code?: string }).code ?? error.message;
        if (code === 'NOT_FOUND') return { status: 404, code };
        if (code === 'CONFLICT') return { status: 409, code };
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
      {
        method: 'GET',
        path: /^\/api\/v1\/csrf$/,
        handle: async () => ({ csrfToken: server.csrfToken() }),
      },
      {
        method: 'GET',
        path: /^\/api\/v1\/overview$/,
        handle: async () => ({
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
        method: 'POST',
        path: /^\/api\/v1\/runtimes\/refresh$/,
        handle: async () => (refreshRuntimes(), { ok: true }),
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/roots$/,
        handle: async ({ body }) => start(startSchema.parse(body)),
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
        handle: async ({ match }) => {
          active.get(match[1]!)?.orchestrator.cancel();
          return { cancelling: active.has(match[1]!) };
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/roots\/([A-Za-z][A-Za-z0-9_-]{0,63})\/accept$/,
        handle: async ({ match, body }) => {
          const { expectedVersion, head } = acceptSchema.parse(body);
          const record = store.graphs.get<RootState>(match[1]!);
          // The user accepts exactly what they reviewed: same version and head.
          if (
            record.rowVersion !== expectedVersion ||
            record.state.phase !== 'ready' ||
            record.state.integration?.head !== head
          )
            throw new HttpError(409, 'CONFLICT');
          store.graphs.update(
            match[1]!,
            expectedVersion,
            { ...record.state, phase: 'accepted' },
            'graph.accepted',
            { actorId: 'user', head },
          );
          return { branch: record.state.integration.branch, head };
        },
      },
      {
        method: 'POST',
        path: /^\/api\/v1\/stop$/,
        handle: async () => {
          for (const entry of active.values()) entry.orchestrator.cancel();
          return { stopping: active.size };
        },
      },
    ],
  });
  return {
    origin: server.origin,
    bootstrapToken: server.bootstrapToken,
    store,
    close: async () => {
      for (const entry of active.values()) entry.orchestrator.cancel();
      await server.close();
      clearInterval(heartbeat);
      store.close();
    },
  };
}
