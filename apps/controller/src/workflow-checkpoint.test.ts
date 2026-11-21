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
import Database from 'better-sqlite3';
import { SCHEMA_VERSION, Store } from '../../../packages/storage/src/store.ts';
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
      runtimeBindings: {
        'native-local': { fingerprint: 'fixture', model: null },
      },
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
        runtimeBindings: {
          'native-local': { fingerprint: 'fixture', model: null },
        },
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

it('migrates schema 6 without treating a legacy node as a redispatchable action', () => {
  const root = mkdtempSync(join(tmpdir(), 'xvant-workflow-schema-'));
  const path = join(root, 'state.sqlite');
  const previous = new Store(path, { owner: 'legacy' });
  previous.graphs.create(
    'legacy',
    'project',
    {
      phase: 'running',
      nodes: {
        child: { status: 'running', repairs: 2, attempts: ['first', 'second'] },
      },
    },
    {},
  );
  previous.close();
  try {
    const old = new Database(path);
    old.exec(
      'DROP TABLE schedule_jobs; DROP TABLE schedule_control; DROP TABLE schedule_projects; ALTER TABLE ownership DROP COLUMN boot; ALTER TABLE ownership DROP COLUMN uptimeExpiry; DROP TABLE work_recoveries; DROP TABLE work_dispatches; DROP TABLE work_actions; DROP TABLE work_checkpoints; PRAGMA user_version=6;',
    );
    old.close();

    const upgraded = new Store(path, {
      owner: 'upgrade',
      recoverWorkGraphs: true,
    });
    try {
      expect(upgraded.schemaVersion()).toBe(SCHEMA_VERSION);
      expect(upgraded.graphs.get('legacy').state).toMatchObject({
        phase: 'needs_attention',
        nodes: {
          child: {
            status: 'needs_attention',
            repairs: 2,
            attempts: ['first', 'second'],
          },
        },
        interruption: { previousPhase: 'running', runningNodeIds: ['child'] },
      });
      expect(upgraded.workflows.actions('legacy')).toEqual([]);
      expect(() => Orchestrator.checkpoint(upgraded, 'legacy')).toThrow(
        'CHECKPOINT_UNAVAILABLE',
      );
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
