import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import {
  LIVE_ROUTES,
  NATIVE_LOCAL_ROUTE,
} from '../../../packages/contracts/src/live.ts';
import type { ProviderKind } from '../../../packages/contracts/src/providers.ts';
import type { ModelProvider } from '../../../packages/native-agent/src/model.ts';
import {
  CampaignStopped,
  HostInterrupted,
  QuotaInterrupted,
  type Configuration,
} from '../../../packages/evaluation/src/runner.ts';
import { LiveTurnRunner } from './turn-runner.ts';
import { NativeTurnRunner } from './native-turn-runner.ts';
import type { LiveEvent } from './codex-live.ts';
import type { RosterRuntime } from './live-roster.ts';
import {
  Orchestrator,
  type TurnRunner,
  type WorkerSpec,
} from './orchestrator.ts';

/**
 * The task's visible tests as registered checks. A runtime needs at least
 * one, so a task without any gets a no-op; the real check stays hidden.
 */
const visibleChecks = (tests: string[] | undefined) =>
  tests?.length
    ? Object.fromEntries(
        tests.map((file, i) => [
          'test' + (i + 1),
          { executable: process.execPath, args: [file] },
        ]),
      )
    : { ready: { executable: process.execPath, args: ['-e', ''] } };

/** Account-level stops: the attempt is incomplete, not a failure of the work. */
const ACCOUNT_BLOCKS = ['QUOTA_BLOCKED', 'AUTH_REQUIRED', 'MODEL_UNAVAILABLE'];

/**
 * An attempt's store has one owner and is never contended, so its lease
 * outlasts a host stall instead of fencing the attempt off after 30 s.
 */
const ATTEMPT_LEASE_MS = 5 * 60 * 1000;

/**
 * Stops that say nothing about the work. A runtime that is no longer the
 * version the campaign recorded refuses every turn, so the campaign ends and
 * the attempt keeps no record; a lost store lease means the host stalled.
 */
const hostStop = (message: string | undefined): Error | undefined =>
  message === 'VERSION_UNSUPPORTED'
    ? new CampaignStopped(
        'the installed runtime is not the version this campaign recorded',
      )
    : message === 'STALE_FENCE'
      ? new HostInterrupted('the controller lost its store lease')
      : undefined;

/** Text put before the objective, e.g. an XVANT skill or the acceptance criteria; absent for a bare baseline. */
export type Instructions = (taskId: string) => string | undefined;

/**
 * A single-worker baseline: one turn per attempt, given the task objective
 * and, when supplied, instructions before it. Every attempt gets its own store, so attempts share nothing.
 * The turn's own outcome only decides whether the work finished; the
 * benchmark's hidden check decides acceptance.
 */
function singleWorker(
  versions: Record<string, string>,
  runtimeKind: WorkerSpec['runtimeKind'],
  stateRoot: string,
  instructions: Instructions | undefined,
  runner: (
    store: Store,
    objects: ArtifactStore,
    worker: WorkerSpec,
    state: string,
    timeoutMs: number,
    onTokens: (tokens: number) => void,
  ) => TurnRunner,
): Configuration {
  const worker: WorkerSpec = {
    alias: runtimeKind + '-bench',
    runtimeKind,
    quotaGroupId: runtimeKind + '-benchmark',
    roles: ['worker'],
  };
  return {
    versions,
    async run({ task, workspace, baseCommit, signal }) {
      const state = join(stateRoot, task.id + '-' + randomUUID().slice(0, 8));
      mkdirSync(state, { recursive: true });
      const store = new Store(join(state, 'state.sqlite'), {
        owner: 'benchmark',
        leaseMs: ATTEMPT_LEASE_MS,
      });
      let tokens: number | null = null;
      try {
        const turns = runner(
          store,
          new ArtifactStore(join(state, 'objects')),
          worker,
          state,
          task.timeoutMs,
          (n) => (tokens = n),
        );
        const taskId = 'bench-' + task.id;
        const stop = () => turns.interrupt(taskId);
        signal.addEventListener('abort', stop, { once: true });
        let outcome;
        try {
          outcome = await turns.run({
            taskId,
            projectId: 'benchmark',
            alias: worker.alias,
            prompt: [instructions?.(task.id), task.objective]
              .filter(Boolean)
              .join('\n\n'),
            workspace: { path: workspace, baseCommit },
            checks: visibleChecks(task.visibleTests),
          });
        } catch (error) {
          throw hostStop((error as Error).message) ?? error;
        } finally {
          signal.removeEventListener('abort', stop);
        }
        const usage = {
          inputTokens: null,
          outputTokens: null,
          totalTokens: tokens,
        };
        if (ACCOUNT_BLOCKS.some((code) => outcome.failure?.startsWith(code)))
          throw new QuotaInterrupted(outcome.failure!);
        return outcome.status === 'accepted' ||
          outcome.status === 'verification_failed'
          ? { outcome: 'finished', usage }
          : {
              outcome: 'gave_up',
              reason: outcome.status + ': ' + (outcome.failure ?? 'no detail'),
              usage,
            };
      } finally {
        store.close();
      }
    },
  };
}

/** One live external runtime (Codex, Claude or OpenCode) on its own login. */
export function liveConfiguration(options: {
  kind: ProviderKind;
  runtime: RosterRuntime;
  /** Per-attempt controller state is created under this directory. */
  stateRoot: string;
  instructions?: Instructions;
  /** Recorded with each attempt, e.g. `skill` or `criteria`. */
  instructionsKind?: string;
  onEvent?: (taskId: string, event: LiveEvent) => void;
}): Configuration {
  const { kind, runtime } = options;
  return singleWorker(
    {
      runtime: kind,
      runtimeVersion: runtime.version ?? LIVE_ROUTES[kind].runtimeVersion,
      adapter: LIVE_ROUTES[kind].adapterVersion,
      model: runtime.model ?? 'default',
      instructions: options.instructions
        ? (options.instructionsKind ?? 'skill')
        : 'none',
    },
    kind,
    options.stateRoot,
    options.instructions,
    (store, objects, worker, _state, timeoutMs, onTokens) =>
      new LiveTurnRunner(
        store,
        objects,
        [worker],
        { [kind]: runtime },
        {
          timeoutMs,
          onEvent: (_alias, taskId, event) => {
            if (event.kind === 'usage' && /^\d+$/.test(event.text))
              onTokens(Number(event.text));
            options.onEvent?.(taskId, event);
          },
        },
      ),
  );
}

/**
 * XVANT's own loop on a model provider. A real local model is `live`; a
 * stub must be `offline`. The loop does not report token usage, so it
 * stays unknown.
 */
export function nativeConfiguration(options: {
  provider: ModelProvider;
  classification: 'offline' | 'live';
  stateRoot: string;
  instructions?: Instructions;
  /** Recorded with each attempt, e.g. `skill` or `criteria`. */
  instructionsKind?: string;
  maxSteps?: number;
}): Configuration {
  return singleWorker(
    {
      runtime: 'native-local',
      runtimeVersion: NATIVE_LOCAL_ROUTE.runtimeVersion,
      adapter: NATIVE_LOCAL_ROUTE.adapterVersion,
      model: options.provider.id,
      instructions: options.instructions
        ? (options.instructionsKind ?? 'skill')
        : 'none',
    },
    'native-local',
    options.stateRoot,
    options.instructions,
    (store, objects, worker, state) =>
      new NativeTurnRunner(store, objects, [worker], options.provider, {
        classification: options.classification,
        limits: { maxSteps: options.maxSteps ?? 24 },
        checkTimeoutMs: 60_000,
        stateDir: join(state, 'checkpoints'),
      }),
  );
}

/**
 * XVANT itself: a planner, workers, host checks with repair rounds and an
 * independent review, all on one live runtime kind. The combined result is
 * checked out in the attempt's workspace so the hidden check judges it.
 * A run that does not reach `ready` is a failed attempt, whatever it built.
 */
export function orchestratedConfiguration(options: {
  kind: ProviderKind;
  runtime: RosterRuntime;
  stateRoot: string;
  /** Acceptance criteria XVANT states to its workers; absent means only the objective. */
  criteria?: (taskId: string) => string[] | undefined;
  /**
   * A separate model that plans and reviews but implements nothing; the
   * runtime's model then only works. Absent means one model does everything.
   */
  plannerModel?: string;
}): Configuration {
  const { kind, runtime, plannerModel } = options;
  const workers: WorkerSpec[] = (
    plannerModel
      ? ([['planner', 'reviewer'], ['worker'], ['worker']] as const)
      : ([
          ['planner', 'worker', 'reviewer'],
          ['worker', 'reviewer'],
        ] as const)
  ).map((roles, i) => ({
    alias: kind + '-bench-' + (i + 1),
    runtimeKind: kind,
    quotaGroupId: kind + '-benchmark',
    roles: [...roles],
    ...(plannerModel && i === 0 ? { model: plannerModel } : {}),
  }));
  return {
    versions: {
      runtime: 'xvant-orchestrated',
      workerRuntime: kind,
      runtimeVersion: runtime.version ?? LIVE_ROUTES[kind].runtimeVersion,
      adapter: LIVE_ROUTES[kind].adapterVersion,
      model: runtime.model ?? 'default',
      ...(plannerModel ? { plannerModel } : {}),
      instructions: options.criteria ? 'criteria' : 'none',
    },
    async run({ task, workspace, baseCommit, signal }) {
      const state = join(
        options.stateRoot,
        task.id + '-' + randomUUID().slice(0, 8),
      );
      mkdirSync(state, { recursive: true });
      const store = new Store(join(state, 'state.sqlite'), {
        owner: 'benchmark',
        leaseMs: ATTEMPT_LEASE_MS,
      });
      let tokens = 0;
      let reported = false;
      let blocked: string | undefined;
      let hostStopped: Error | undefined;
      try {
        const runner = new LiveTurnRunner(
          store,
          new ArtifactStore(join(state, 'objects')),
          workers,
          { [kind]: runtime },
          {
            timeoutMs: task.timeoutMs,
            onEvent: (_alias, _taskId, event) => {
              if (event.kind === 'usage' && /^\d+$/.test(event.text)) {
                tokens += Number(event.text);
                reported = true;
              }
            },
          },
        );
        // Account blocks and host stops surface on the turn, not on the root: watch for them.
        const turns: TurnRunner = {
          interrupt: (taskId) => runner.interrupt(taskId),
          async run(request) {
            const outcome = await runner.run(request).catch((error) => {
              hostStopped ??= hostStop((error as Error).message);
              throw error;
            });
            if (ACCOUNT_BLOCKS.some((c) => outcome.failure?.startsWith(c)))
              blocked ??= outcome.failure;
            return outcome;
          },
        };
        const orchestrator = new Orchestrator(store, turns, workers, {
          stateRoot: join(state, 'runs'),
        });
        const stop = () => orchestrator.cancel();
        signal.addEventListener('abort', stop, { once: true });
        let root;
        try {
          root = await orchestrator.run({
            id: 'bench',
            projectId: 'benchmark',
            repository: workspace,
            baseRevision: baseCommit,
            objective: task.objective,
            acceptanceCriteria: options.criteria?.(task.id) ?? [
              'The objective is met',
            ],
            checks: task.visibleTests?.length
              ? visibleChecks(task.visibleTests)
              : {},
          });
        } finally {
          signal.removeEventListener('abort', stop);
        }
        const usage = {
          inputTokens: null,
          outputTokens: null,
          // Planner and reviewer turns report no usage through this path.
          totalTokens: reported ? tokens : null,
        };
        hostStopped ??= hostStop(root.reason);
        if (hostStopped) throw hostStopped;
        if (blocked) throw new QuotaInterrupted(blocked);
        if (root.phase !== 'ready' || !root.integration)
          return {
            outcome: 'gave_up',
            reason: root.phase + ': ' + (root.reason ?? 'no detail'),
            usage,
          };
        execFileSync(
          'git',
          ['checkout', '-q', '--detach', root.integration.head],
          { cwd: workspace, windowsHide: true },
        );
        return {
          outcome: 'finished',
          usage,
          conflicts: 0,
          recovered: Object.values(root.nodes).some((n) => n.repairs > 0),
        };
      } finally {
        store.close();
      }
    },
  };
}
