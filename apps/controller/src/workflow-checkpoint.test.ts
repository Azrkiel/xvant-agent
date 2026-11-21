import {
  mkdtempSync,
  rmSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { Store } from '../../../packages/storage/src/store.ts';
import { Orchestrator, type TurnRunner } from './orchestrator.ts';

it('round-trips the resolved executable spec and worker bindings in the graph transaction', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-checkpoint-')));
  const repository = join(root, 'repo');
  mkdirSync(repository);
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
      {
        cwd: repository,
        encoding: 'utf8',
      },
    ).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repository, 'README.md'), 'fixture');
  git('add', '.');
  git('commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  const db = join(root, 'state.sqlite');
  const store = new Store(db, { owner: 'first' });
  const worker = {
    alias: 'worker',
    runtimeKind: 'native-local' as const,
    quotaGroupId: 'fixture',
    roles: ['worker' as const],
  };
  const runner: TurnRunner = {
    run: async () => ({
      status: 'accepted',
      patch: null,
      files: [],
      finalText: 'done',
    }),
    interrupt: () => false,
  };
  try {
    const orchestrator = new Orchestrator(store, runner, [worker], {
      stateRoot: join(root, 'runs'),
      turnTimeoutMs: 9000,
      runtimeBindings: { 'native-local': 'fixture' },
    });
    expect(
      await orchestrator.run({
        id: 'root',
        projectId: 'project',
        repository,
        baseRevision: 'HEAD',
        objective: 'Round-trip',
        acceptanceCriteria: ['No work lost'],
        checks: { test: { executable: process.execPath, args: ['-e', ''] } },
        nodeChecks: ['test'],
        plan: {
          summary: 'One node',
          nodes: [
            {
              id: 'node',
              title: 'Node',
              objective: 'Produce a result',
              acceptanceCriteria: ['Result'],
            },
          ],
        },
        maxRepairs: 4,
        maxReviewRepairs: 2,
        checkTimeoutMs: 5000,
        review: false,
      }),
    ).toMatchObject({ phase: 'ready' });
    store.close();
    const reopened = new Store(db, {
      owner: 'second',
      recoverWorkGraphs: true,
    });
    try {
      const checkpoint = Orchestrator.checkpoint(reopened, 'root');
      expect(checkpoint).toMatchObject({
        schemaVersion: 1,
        authority: 'legacy-manual',
        workers: [worker],
        stateRoot: join(root, 'runs'),
        turnTimeoutMs: 9000,
        runtimeBindings: { 'native-local': 'fixture' },
        spec: {
          repository,
          baseRevision: head,
          maxActive: 3,
          maxRepairs: 4,
          maxReviewRepairs: 2,
          checkTimeoutMs: 5000,
          nodeChecks: ['test'],
          review: false,
        },
        progress: { turnCount: 1 },
      });
      expect(reopened.graphs.get('root').state).toMatchObject({
        integration: { head },
      });
      expect(() => Orchestrator.checkpoint(reopened, 'missing')).toThrow(
        'CHECKPOINT_UNAVAILABLE',
      );
      reopened.workflows.write('root', { ...checkpoint, schemaVersion: 99 });
      expect(() => Orchestrator.checkpoint(reopened, 'root')).toThrow(
        'CHECKPOINT_INVALID',
      );
      expect(reopened.workflows.read('root')).toMatchObject({
        schemaVersion: 99,
      });
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
