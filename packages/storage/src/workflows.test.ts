import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ArtifactStore, backupSnapshot, restoreSnapshot } from './artifacts.ts';
import { SCHEMA_VERSION, Store } from './store.ts';

it('atomically records progress and intent, fences claims, and deduplicates exact results', () => {
  const root = mkdtempSync(join(tmpdir(), 'xvant-workflows-'));
  const path = join(root, 'state.sqlite');
  let kill = false;
  let writer = new Store(path, {
    owner: 'first',
    fault: (point) => {
      if (kill && point === 'workflow.intent.before_commit:node')
        throw new Error('rollback');
    },
  });
  try {
    writer.graphs.create('root', 'project', { phase: 'running' }, {});
    const prepare = () =>
      writer.workflows.atomic(() => {
        writer.graphs.update(
          'root',
          1,
          { phase: 'working' },
          'node.dispatched',
          {},
        );
        writer.workflows.write('root', { cursor: 'node' });
        return writer.workflows.prepare('root', 'node', 'turn', {
          taskId: 'task',
        });
      });
    kill = true;
    expect(prepare).toThrow('rollback');
    expect(writer.workflows.read('root')).toBeNull();
    expect(writer.workflows.actions('root')).toEqual([]);
    expect(writer.graphs.get('root').rowVersion).toBe(1);
    kill = false;
    const pending = prepare();
    expect(pending.status).toBe('prepared');
    writer.close();
    writer = new Store(path, { owner: 'second' });
    const claimed = writer.workflows.claim('root', 'node');
    expect(claimed.generation).toBeGreaterThan(pending.generation);
    expect(() => writer.workflows.claim('root', 'node')).toThrow(
      'UNRESOLVED_WORKFLOW_ACTION',
    );
    expect(() =>
      writer.workflows.complete('root', 'node', pending.generation, {
        result: 'obsolete',
      }),
    ).toThrow('STALE_FENCE');
    writer.workflows.complete('root', 'node', claimed.generation, {
      result: 'exact',
    });
    writer.workflows.complete('root', 'node', claimed.generation, {
      result: 'exact',
    });
    expect(() =>
      writer.workflows.complete('root', 'node', claimed.generation, {
        result: 'changed',
      }),
    ).toThrow('CONFLICT');
    expect(writer.workflows.action('root', 'node')).toMatchObject({
      status: 'completed',
      result: { result: 'exact' },
    });
    writer.close();
    writer = new Store(path, { owner: 'third' });
    expect(writer.workflows.read('root')).toEqual({ cursor: 'node' });
    expect(writer.graphs.get('root').rowVersion).toBe(2);
    expect(() =>
      writer.workflows.complete('root', 'node', claimed.generation, {
        result: 'exact',
      }),
    ).toThrow('STALE_FENCE');
  } finally {
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps original intent and fences superseded dispatch IDs within one generation', () => {
  const store = new Store(':memory:', { owner: 'controller' });
  try {
    const { workflows } = store;
    store.graphs.create('root', 'project', { phase: 'running' }, {});
    const input = { taskId: 'task', deadlineAt: 12345 };
    workflows.prepare('root', 'node', 'turn', input);
    const descriptor = {
      attemptId: 'task-a1',
      resources: ['worker:worker'],
      adapter: null,
    };
    const first = workflows.claim('root', 'node', descriptor);
    const snapshot = workflows.dispatch('root', first);
    const decision = workflows.reconcile('root', first, snapshot, {
      classification: 'not_started',
      source: 'sqlite_dispatch',
      evidence: { armed: false },
      detail: 'Unarmed claim',
    });
    expect(decision).toMatchObject({
      decision: 'retry',
      attemptId: 'task-a1',
      dispatchId: first.dispatchId,
    });
    expect(workflows.action('root', 'node')).toMatchObject({
      input,
      status: 'prepared',
    });
    const second = workflows.claim('root', 'node', descriptor);
    expect(second.generation).toBe(first.generation);
    expect(second.dispatchId).not.toBe(first.dispatchId);
    expect(second.operationId).toBe(first.operationId);
    expect(() => workflows.arm('root', first, () => false)).toThrow(
      'STALE_FENCE',
    );
    workflows.arm('root', second, () => false);
    expect(workflows.occupied('worker:worker')).toBe(true);
    expect(() => workflows.observe('root', first, { accepted: true })).toThrow(
      'STALE_FENCE',
    );
    expect(() =>
      workflows.complete(
        'root',
        'node',
        first.generation,
        { accepted: true },
        first.dispatchId,
      ),
    ).toThrow('STALE_FENCE');
    const stale = workflows.dispatch('root', second);
    workflows.observe('root', second, { accepted: false });
    expect(() =>
      workflows.reconcile('root', second, stale, {
        classification: 'unresolved',
        source: 'fixture',
        evidence: {},
        detail: 'stale probe',
      }),
    ).toThrow('STALE_FENCE');
    expect(() =>
      workflows.complete(
        'root',
        'node',
        second.generation,
        { accepted: true },
        second.dispatchId,
      ),
    ).toThrow('CONFLICT');
    workflows.complete(
      'root',
      'node',
      second.generation,
      { accepted: false },
      second.dispatchId,
    );
    expect(workflows.occupied('worker:worker')).toBe(false);
    expect(workflows.recoveries('root')).toEqual([decision]);
  } finally {
    store.close();
  }
});

it('upgrades schema 7 dispatches without inventing receipts or releasing reservations', () => {
  const root = mkdtempSync(join(tmpdir(), 'xvant-recovery-upgrade-'));
  const path = join(root, 'state.sqlite');
  let store = new Store(path, { owner: 'legacy' });
  try {
    store.graphs.create('root', 'project', { phase: 'running' }, {});
    store.workflows.prepare('root', 'node', 'turn', {
      taskId: 'task',
      alias: 'worker',
    });
    const dispatch = store.workflows.claim('root', 'node');
    delete dispatch.operationId;
    store.close();
    const db = new Database(path);
    try {
      db.exec(
        "DROP TABLE contract_manager_runs; DROP TABLE contract_backlogs; DROP TABLE schedule_jobs; DROP TABLE schedule_control; DROP TABLE schedule_projects; ALTER TABLE ownership DROP COLUMN boot; ALTER TABLE ownership DROP COLUMN uptimeExpiry; DROP TABLE work_recoveries; DROP TABLE work_dispatches; UPDATE work_actions SET body=json_remove(body,'$.operationId'); PRAGMA user_version=7;",
      );
    } finally {
      db.close();
    }
    store = new Store(path, { owner: 'replacement' });
    const { workflows } = store;
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(workflows.actions('root')).toEqual([dispatch]);
    expect(workflows.dispatch('root', dispatch)).toBeNull();
    expect(workflows.occupied('worker:worker')).toBe(true);
    const probe = {
      classification: 'unresolved',
      source: 'legacy_action',
      evidence: {},
      detail: 'Missing receipt',
    } as const;
    const decision = workflows.reconcile('root', dispatch, null, probe);
    expect(workflows.reconcile('root', dispatch, null, probe)).toEqual(
      decision,
    );
    expect(workflows.recoveries('root')).toEqual([decision]);
    expect(decision).toMatchObject({
      decision: 'block',
      attemptId: 'task-a1',
      dispatchId: null,
    });
    expect(workflows.actions('root')).toEqual([dispatch]);
    expect(workflows.occupied('worker:worker')).toBe(true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves staged patch evidence and audit decisions in a verified snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xvant-recovery-backup-'));
  const store = new Store(join(root, 'state.sqlite'), { owner: 'controller' });
  try {
    const { workflows } = store;
    const objects = new ArtifactStore(join(root, 'objects'));
    const patch = Buffer.from('original patch');
    const patchHash = objects.put(patch);
    store.graphs.create('root', 'project', { phase: 'running' }, {});
    workflows.prepare('root', 'node', 'turn', {
      taskId: 'task',
      alias: 'worker',
    });
    const action = workflows.claim('root', 'node', {
      attemptId: 'task-a1',
      resources: ['worker:worker'],
      adapter: null,
    });
    const dispatch = workflows.arm('root', action, () => false);
    const decision = workflows.reconcile('root', action, dispatch, {
      classification: 'unresolved',
      source: 'fixture',
      evidence: {},
      detail: 'Waiting for receipt',
    });
    workflows.observe('root', action, { patchHash });
    const snapshot = join(root, 'snapshot');
    await backupSnapshot(store, objects, snapshot);
    const destination = join(root, 'restored');
    await restoreSnapshot(snapshot, destination);
    const restored = new Store(join(destination, 'state.sqlite'), {
      owner: 'restored',
      now: () => Date.now() + 60_000,
    });
    try {
      expect(restored.workflows.recoveries('root')).toEqual([decision]);
      expect(restored.workflows.dispatch('root', action)).toMatchObject({
        observation: { patchHash },
      });
      expect(restored.workflows.occupied('worker:worker')).toBe(true);
      expect(
        new ArtifactStore(join(destination, 'artifacts')).get(patchHash),
      ).toEqual(patch);
    } finally {
      restored.close();
    }
    rmSync(join(root, 'objects', patchHash));
    await expect(
      backupSnapshot(store, objects, join(root, 'missing-patch')),
    ).rejects.toThrow('ARTIFACT_MISSING');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
