import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  Orchestrator,
  type TurnRunner,
  type TurnOutcome,
  type WorkerSpec,
} from '../../apps/controller/src/orchestrator.ts';
import type {
  RemoteTurnRecovery,
  TurnCorrelation,
} from '../../apps/controller/src/workflow-recovery.ts';
import { Store } from '../../packages/storage/src/store.ts';

const workers: WorkerSpec[] = [
  {
    alias: 'planner',
    runtimeKind: 'native-local',
    quotaGroupId: 'fixture',
    roles: ['worker', 'planner'],
  },
];
const plan = JSON.stringify({
  summary: 'Use the saved service response',
  nodes: [
    {
      id: 'work',
      title: 'Work',
      objective: 'Complete work',
      acceptanceCriteria: ['Done'],
    },
  ],
});
const terminal: TurnOutcome = {
  status: 'accepted',
  finalText: plan,
  patch: null,
  files: [],
};
const complete = (key: TurnCorrelation) => ({ ...key, outcome: terminal });
const unknown: TurnOutcome = { ...terminal, status: 'unknown', finalText: '' };

it.each(['lookup', 'replay', 'opaque', 'timeout', 'misbound'] as const)(
  'reconciles a lost effect response according to the %s adapter capability',
  async (mode) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-remote-')));
    const repository = join(root, 'repo');
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          ...args,
        ],
        { cwd: repository },
      );
    mkdirSync(repository);
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repository, 'readme.txt'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const effects: TurnCorrelation[] = [];
    const submits: { key: TurnCorrelation; condition: string | undefined }[] =
      [];
    const lookups: TurnCorrelation[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      const key = {
        operationId: url.searchParams.get('op')!,
        attemptId: url.searchParams.get('attempt')!,
      };
      const known = effects.some(
        (effect) =>
          effect.operationId === key.operationId &&
          effect.attemptId === key.attemptId,
      );
      if (req.method === 'GET') {
        lookups.push(key);
        if (mode === 'timeout') return;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            known
              ? complete(
                  mode === 'misbound'
                    ? { ...key, attemptId: 'different-attempt' }
                    : key,
                )
              : null,
          ),
        );
        return;
      }
      submits.push({ key, condition: req.headers['if-none-match'] });
      if (mode === 'replay' && req.headers['if-none-match'] === '*' && known) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(complete(key)));
        return;
      }
      effects.push(key);
      // Commit the observable effect, then drop the first response.
      req.socket.destroy();
    });
    let store: Store | undefined;
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const origin =
        'http://127.0.0.1:' + (server.address() as AddressInfo).port;
      const endpoint = ({ operationId, attemptId }: TurnCorrelation) =>
        origin +
        '/?' +
        new URLSearchParams({ op: operationId, attempt: attemptId });
      const recovery: RemoteTurnRecovery = {
        identity: 'fake-service-v1',
        scope: 'fixture-effect',
      };
      if (['lookup', 'timeout', 'misbound'].includes(mode))
        recovery.lookup = async (key, signal) =>
          (await fetch(endpoint(key), { signal })).json();
      if (mode === 'replay')
        recovery.replay = async (key, _request, signal) =>
          (
            await fetch(endpoint(key), {
              signal,
              method: 'POST',
              headers: { 'If-None-Match': '*' },
            })
          ).json();
      const runner: TurnRunner = {
        remoteRecovery: recovery,
        interrupt: () => false,
        run: async (request, execution) => {
          if (!request.taskId.includes('-plan-'))
            return { ...terminal, finalText: 'Done' };
          try {
            await fetch(endpoint(execution!), {
              method: 'POST',
              ...(mode === 'replay'
                ? { headers: { 'If-None-Match': '*' } }
                : {}),
            });
            throw new Error('FIXTURE_RESPONSE_NOT_LOST');
          } catch (error) {
            if ((error as Error).message !== 'fetch failed') throw error;
            return unknown;
          }
        },
      };
      const path = join(root, 'state.sqlite');
      store = new Store(path, { owner: 'first' });
      const controller = () =>
        new Orchestrator(store!, runner, workers, {
          stateRoot: join(root, 'runs'),
        });
      const initial = await controller().run({
        id: 'root',
        projectId: 'fixture',
        repository,
        baseRevision: 'HEAD',
        objective: 'Complete a remote effect',
        acceptanceCriteria: ['Done'],
        checks: {},
        review: false,
      });
      expect(initial.phase).toBe('needs_attention');
      expect(initial.reason).toContain('plan:0');
      expect(effects).toHaveLength(1);
      const original = store.workflows.action('root', 'plan:0')!;
      expect(original.status).toBe('dispatching');
      const key = effects[0]!;
      expect(key).toEqual({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        attemptId: 'root-plan-1-a1',
      });
      expect(store.workflows.occupied('remote:fixture-effect')).toBe(true);
      store.close();
      store = new Store(path, { owner: 'resumed', recoverWorkGraphs: true });

      if (mode === 'lookup' || mode === 'replay') {
        expect(await controller().resume('root')).toMatchObject({
          phase: 'ready',
        });
        expect(store.workflows.action('root', 'plan:0')).toMatchObject({
          status: 'completed',
          input: original.input,
        });
        expect(store.workflows.recoveries('root').at(-1)).toMatchObject({
          slot: 'plan:0',
          attemptId: key.attemptId,
          operationId: key.operationId,
          classification: 'completed_verifiable',
          decision: 'resume',
          source:
            mode === 'lookup' ? 'remote_lookup' : 'remote_idempotent_replay',
        });
        expect(store.workflows.occupied('remote:fixture-effect')).toBe(false);
        expect((await controller().resume('root')).phase).toBe('ready');
      } else {
        if (mode === 'timeout')
          await expect(controller().resume('root')).rejects.toThrow(
            'PROBE_TIMEOUT',
          );
        if (mode === 'misbound')
          await expect(controller().resume('root')).rejects.toThrow(
            'STALE_EVIDENCE',
          );
        if (mode === 'opaque') {
          await expect(controller().resume('root')).rejects.toThrow(
            'REMOTE_LOOKUP_UNAVAILABLE',
          );
          const recorded = store.workflows.recoveries('root');
          await expect(controller().resume('root')).rejects.toThrow(
            'REMOTE_LOOKUP_UNAVAILABLE',
          );
          expect(store.workflows.recoveries('root')).toEqual(recorded);
          store.close();
          store = new Store(path, { owner: 'third' });
          await expect(controller().resume('root')).rejects.toThrow(
            'REMOTE_LOOKUP_UNAVAILABLE',
          );
        }
        expect(store.workflows.action('root', 'plan:0')).toEqual(original);
        expect(store.workflows.occupied('remote:fixture-effect')).toBe(true);
        expect(store.workflows.recoveries('root').at(-1)).toMatchObject({
          slot: 'plan:0',
          attemptId: key.attemptId,
          classification: 'unresolved',
          decision: 'block',
          operatorAction: expect.any(String),
        });
      }
      expect(effects).toEqual([key]);
      expect(submits).toEqual([
        { key, condition: mode === 'replay' ? '*' : undefined },
        ...(mode === 'replay' ? [{ key, condition: '*' }] : []),
      ]);
      expect(lookups).toEqual(
        ['lookup', 'timeout', 'misbound'].includes(mode) ? [key] : [],
      );
    } finally {
      store?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
