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
  QuotaInterrupted,
  type Configuration,
} from '../../../packages/evaluation/src/runner.ts';
import { LiveTurnRunner } from './turn-runner.ts';
import { NativeTurnRunner } from './native-turn-runner.ts';
import type { LiveEvent } from './codex-live.ts';
import type { RosterRuntime } from './live-roster.ts';
import type { TurnRunner, WorkerSpec } from './orchestrator.ts';

/** Account-level stops: the attempt is incomplete, not a failure of the work. */
const ACCOUNT_BLOCKS = ['QUOTA_BLOCKED', 'AUTH_REQUIRED', 'MODEL_UNAVAILABLE'];

/** Text put before the objective, e.g. an XVANT skill; absent for a bare baseline. */
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
            // The runtime needs one registered check; the real one stays hidden.
            checks: {
              ready: { executable: process.execPath, args: ['-e', ''] },
            },
          });
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
  onEvent?: (taskId: string, event: LiveEvent) => void;
}): Configuration {
  const { kind, runtime } = options;
  return singleWorker(
    {
      runtime: kind,
      runtimeVersion: runtime.version ?? LIVE_ROUTES[kind].runtimeVersion,
      adapter: LIVE_ROUTES[kind].adapterVersion,
      model: runtime.model ?? 'default',
      instructions: options.instructions ? 'skill' : 'none',
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
  maxSteps?: number;
}): Configuration {
  return singleWorker(
    {
      runtime: 'native-local',
      runtimeVersion: NATIVE_LOCAL_ROUTE.runtimeVersion,
      adapter: NATIVE_LOCAL_ROUTE.adapterVersion,
      model: options.provider.id,
      instructions: options.instructions ? 'skill' : 'none',
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
