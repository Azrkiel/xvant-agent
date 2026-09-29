import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import type { ProviderKind } from '../../../packages/contracts/src/providers.ts';
import { CODEX_VERSION } from '../../../packages/adapters/src/codex/profile.ts';
import { versions } from '../../../packages/adapters/src/providers/native-profiles.ts';
import { OfflineCodexController } from './codex-offline.ts';
import { OfflineNativeController } from './native-offline.ts';

/** Target registry: 2 Codex, 3 Claude and 5 OpenCode named workers. */
export const ROSTER: readonly {
  kind: ProviderKind;
  scenario: string;
  mode: 'resume' | 'create';
}[] = [
  { kind: 'codex', scenario: 'success', mode: 'resume' },
  { kind: 'codex', scenario: 'approval', mode: 'create' },
  { kind: 'claude', scenario: 'permission', mode: 'resume' },
  { kind: 'claude', scenario: 'interrupt', mode: 'resume' },
  { kind: 'claude', scenario: 'success', mode: 'create' },
  { kind: 'opencode', scenario: 'success', mode: 'resume' },
  { kind: 'opencode', scenario: 'permission', mode: 'resume' },
  { kind: 'opencode', scenario: 'interrupt', mode: 'create' },
  { kind: 'opencode', scenario: 'quota-error', mode: 'resume' },
  // The fixed peer mints one created ID, so a second OpenCode create would
  // (correctly) collide; an attempt-scoped error exercises failure routing.
  { kind: 'opencode', scenario: 'error', mode: 'resume' },
];
export interface RosterResult {
  workerId: string;
  runtimeKind: ProviderKind;
  scenario: string;
  mode: 'resume' | 'create';
  nativeSessionId: string;
  state: string;
  outcome: string | null;
  verification: string | null;
  failure: string | null;
  interruptActor: string | null;
  outgoing: string[];
}
const claudeIds = [
  '8f5a2c1e-7a4b-4d2c-9e1f-0a1b2c3d4e01',
  '8f5a2c1e-7a4b-4d2c-9e1f-0a1b2c3d4e02',
  '8f5a2c1e-7a4b-4d2c-9e1f-0a1b2c3d4e03',
];
/**
 * Runs all ten named offline workers concurrently through the owned controllers,
 * sharing one Store. Each worker has its own task, workspace, native session and
 * per-runtime account group; interrupts target one connection by ID. Synthetic
 * peers only: this proves routing and isolation, not live provider support.
 */
export async function runControllerRoster(root: string, timeoutMs = 10000) {
  const store = new Store(join(root, 'state.sqlite'), { owner: 'roster' });
  const objects = new ArtifactStore(join(root, 'objects'));
  const checks = {
    check: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
  };
  const workspaces: Record<string, string> = {};
  const counts: Record<ProviderKind, number> = {
    codex: 0,
    claude: 0,
    opencode: 0,
  };
  const workers = ROSTER.map((entry) => {
    const n = ++counts[entry.kind];
    const workerId = `${entry.kind}_${n}`;
    const workspace = join(root, 'work', workerId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'result.txt'), workerId);
    workspaces[workerId] = workspace;
    return { ...entry, workerId, n };
  });
  const codex = new OfflineCodexController(store, objects, workspaces, checks, {
    timeoutMs,
  });
  const native = new OfflineNativeController(
    store,
    objects,
    workspaces,
    checks,
    { timeoutMs },
  );
  try {
    const runs = workers.map((worker) => {
      const taskId = 'task_' + worker.workerId;
      store.create('create_' + worker.workerId, {
        id: taskId,
        projectId: 'roster',
        objective: 'Read ' + worker.workerId,
        requiredCheckIds: ['check'],
        acceptanceCriteria: ['Pass'],
      });
      store.queue('queue_' + worker.workerId, taskId, 0);
      const dispatch = {
        connectionId: 'connection_' + worker.workerId,
        taskId,
        attemptId: 'attempt_' + worker.workerId,
        workspaceId: worker.workerId,
        expectedVersion: 1,
        classification: 'offline' as const,
        worker: {
          id: worker.workerId,
          alias: `${worker.kind}-${worker.n}`,
          runtimeKind: worker.kind,
          hostId: 'host',
          endpointId: 'fixture',
          nativeSessionId:
            worker.kind === 'claude' && worker.mode === 'create'
              ? claudeIds[worker.n - 1]!
              : `session_${worker.workerId}`,
          runtimeVersion:
            worker.kind === 'codex' ? CODEX_VERSION : versions[worker.kind],
          adapterVersion: 'v1',
          mode: 'managed' as const,
          quotaGroupId: worker.kind + '_account',
        },
      };
      const controller = worker.kind === 'codex' ? codex : native;
      return controller.run(dispatch, worker.scenario, worker.mode);
    });
    // Operator interrupts target a single named connection once it is running.
    await Promise.all(
      workers
        .filter((worker) => worker.scenario === 'interrupt')
        .map(async (worker) => {
          for (let tries = 0; ; tries++) {
            try {
              return (worker.kind === 'codex' ? codex : native).interrupt(
                'connection_' + worker.workerId,
                'operator_' + worker.workerId,
              );
            } catch (error) {
              if (
                (error as Error).message !== 'NOT_INTERRUPTIBLE' ||
                tries > 2000
              )
                throw error;
              await new Promise((done) => setTimeout(done, 5));
            }
          }
        }),
    );
    const tasks = await Promise.all(runs);
    const results: RosterResult[] = workers.map((worker, index) => {
      const connection = store.providers.get('connection_' + worker.workerId);
      return {
        workerId: worker.workerId,
        runtimeKind: worker.kind,
        scenario: worker.scenario,
        mode: worker.mode,
        nativeSessionId: connection.worker.nativeSessionId,
        state: tasks[index]!.state,
        outcome: connection.outcome,
        verification: connection.verification?.status ?? null,
        failure: connection.failure?.code ?? null,
        interruptActor: connection.interrupt?.actorId ?? null,
        outgoing: store.providers
          .entries(connection.connectionId)
          .filter((entry) => entry.direction === 'out')
          .map((entry) => entry.method ?? ''),
      };
    });
    return {
      classification: 'offline' as const,
      liveProvidersTested: [] as string[],
      results,
      blocked: {
        codex: store.providers.blocked('codex_account')?.code ?? null,
        claude: store.providers.blocked('claude_account')?.code ?? null,
        opencode: store.providers.blocked('opencode_account')?.code ?? null,
      },
      activeCount: codex.activeCount + native.activeCount,
      accepted: store
        .events(0)
        .some((event) => event.kind === 'native.accepted'),
    };
  } finally {
    codex.stop();
    native.stop();
    store.close();
  }
}
/** Pure expectation check shared by the test and G03 fixture. */
export function rosterFailures(
  report: Awaited<ReturnType<typeof runControllerRoster>>,
): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  const { results } = report;
  expect(results.length === 10, 'roster size');
  for (const [kind, count] of [
    ['codex', 2],
    ['claude', 3],
    ['opencode', 5],
  ] as const)
    expect(
      results.filter((result) => result.runtimeKind === kind).length === count,
      'count ' + kind,
    );
  expect(
    // Native sessions are unique per runtime and host, as reservations are keyed.
    new Set(
      results.map(
        (result) => result.runtimeKind + ':' + result.nativeSessionId,
      ),
    ).size === 10,
    'distinct sessions',
  );
  for (const result of results) {
    const id = result.workerId;
    const denial =
      result.runtimeKind === 'codex'
        ? 'turn/start'
        : 'fixture/permission-denial';
    if (
      result.scenario === 'success' ||
      result.scenario === 'permission' ||
      result.scenario === 'approval'
    ) {
      expect(result.state === 'ready_for_acceptance', id + ' state');
      expect(result.verification === 'passed', id + ' verification');
      expect(result.failure === null, id + ' failure');
    }
    if (result.scenario === 'interrupt') {
      expect(result.outcome === 'cancelled', id + ' outcome');
      expect(result.interruptActor === 'operator_' + id, id + ' actor');
      expect(result.verification === null, id + ' verification');
    } else expect(result.interruptActor === null, id + ' stray interrupt');
    expect(
      result.outgoing.includes('fixture/interrupt') ===
        (result.scenario === 'interrupt'),
      id + ' interrupt routing',
    );
    if (result.runtimeKind !== 'codex')
      expect(
        result.outgoing.includes(denial) === (result.scenario === 'permission'),
        id + ' denial routing',
      );
    if (result.scenario === 'error') {
      expect(result.state === 'needs_attention', id + ' state');
      expect(result.failure === 'WORKER_FAILED', id + ' failure');
    }
    if (result.scenario === 'quota-error') {
      expect(result.outcome === 'failed', id + ' outcome');
      expect(result.failure === 'QUOTA_BLOCKED', id + ' failure');
    }
  }
  expect(report.blocked.opencode === 'QUOTA_BLOCKED', 'opencode block');
  expect(
    report.blocked.codex === null && report.blocked.claude === null,
    'block isolation',
  );
  expect(report.activeCount === 0, 'owned processes');
  expect(!report.accepted, 'no acceptance');
  return problems;
}
