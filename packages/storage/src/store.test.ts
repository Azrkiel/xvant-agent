import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from './store.ts';
const input = {
  id: 'task',
  projectId: 'project',
  objective: 'Build fixture',
  requiredCheckIds: ['test'],
  acceptanceCriteria: ['Pass'],
};
let root: string;
let store: Store;
let now: number;
const stores: Store[] = [];
function open(owner = 'controller', fault?: (point: string) => void) {
  const s = new Store(join(root, 'state.sqlite'), {
    owner,
    now: () => now,
    leaseMs: 1000,
    ...(fault ? { fault } : {}),
  });
  stores.push(s);
  return s;
}
function prepared() {
  store.create('create', input);
  store.queue('queue', 'task', 0);
  return store.dispatch('dispatch', {
    taskId: 'task',
    workerId: 'worker',
    attemptId: 'attempt',
    workspaceId: 'workspace',
    sessionId: 'session',
    scenario: 'success',
    expectedVersion: 1,
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-store-'));
  now = 1000;
  store = open();
});
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  rmSync(root, { recursive: true, force: true });
});
describe('durable store', () => {
  it('persists task, command, event and dispatch intent across restart', () => {
    prepared();
    store.close();
    store = open('next');
    expect(store.getTask('task').state).toBe('running');
    expect(store.getOperation('attempt').status).toBe('prepared');
    expect(store.events(0)).toHaveLength(3);
    expect(store.create('create', input).id).toBe('task');
    expect(store.integrity()).toBe('ok');
  });
  it('rolls all dispatch rows back when interrupted before commit', () => {
    store.close();
    store = open('controller', (p) => {
      if (p === 'dispatch.before_commit') throw new Error('crash');
    });
    expect(prepared).toThrow('crash');
    expect(store.getTask('task').state).toBe('queued');
    expect(store.events(0)).toHaveLength(2);
    expect(() => store.getOperation('attempt')).toThrow('NOT_FOUND');
  });
  it('rejects same command key with different payload and returns original result on retry', () => {
    const first = store.create('create', input);
    store.queue('queue', 'task', 0);
    expect(store.create('create', { ...input })).toEqual(first);
    expect(() =>
      store.create('create', { ...input, objective: 'different' }),
    ).toThrow('CONFLICT');
  });
  it('rejects stale task revisions without creating event or operation', () => {
    store.create('create', input);
    store.queue('queue', 'task', 0);
    expect(() => store.queue('other', 'task', 0)).toThrow('CONFLICT');
    expect(store.events(0)).toHaveLength(2);
  });
  it('enforces controller exclusivity and fences the expired owner', () => {
    expect(() => open('second')).toThrow('LEASE_BUSY');
    now += 1001;
    const second = open('second');
    expect(() => store.create('create', input)).toThrow('STALE_FENCE');
    expect(second.create('create', input).id).toBe('task');
  });
  it('renews controller lease without changing generation', () => {
    now += 900;
    store.heartbeat();
    now += 900;
    expect(store.create('create', input).id).toBe('task');
  });
  it('lets a stalled owner resume if nobody took the lease over', () => {
    now += 5000;
    expect(store.create('create', input).id).toBe('task');
    // The lease is live again, so a second controller is still refused.
    expect(() => open('second')).toThrow('LEASE_BUSY');
    now += 5000;
    store.heartbeat();
    expect(() => open('second')).toThrow('LEASE_BUSY');
  });
  it('rejects reuse of occupied workspace, session or worker', () => {
    prepared();
    store.create('create2', { ...input, id: 'task2' });
    store.queue('queue2', 'task2', 0);
    for (const field of ['workspaceId', 'sessionId', 'workerId'] as const) {
      const spec = {
        taskId: 'task2',
        workerId: 'worker2',
        attemptId: 'attempt2',
        workspaceId: 'workspace2',
        sessionId: 'session2',
        scenario: 'success' as const,
        expectedVersion: 1,
      };
      spec[field] = {
        workspaceId: 'workspace',
        sessionId: 'session',
        workerId: 'worker',
      }[field];
      expect(() => store.dispatch('dispatch2', spec)).toThrow('LEASE_BUSY');
    }
  });
  it.each(['sending', 'running'] as const)(
    'reconciles %s to unknown without redispatch',
    (status) => {
      const op = prepared();
      store.markSending('attempt', op.token);
      if (status === 'running')
        store.receive('attempt', op.token, {
          schemaVersion: 1,
          sequence: 1,
          taskId: 'task',
          attemptId: 'attempt',
          workerId: 'worker',
          runtimeKind: 'simulated',
          simulated: true,
          kind: 'started',
        });
      store.close();
      store = open('next');
      expect(store.recover()).toEqual(['attempt']);
      expect(store.getTask('task').state).toBe('needs_attention');
      expect(store.getOperation('attempt').reason).toBe('unknown');
      expect(() => store.markSending('attempt', op.token)).toThrow();
      expect(store.recover()).toEqual([]);
    },
  );
  it('requires a fresh token and current ownership for worker results', () => {
    const op = prepared();
    store.markSending('attempt', op.token);
    const event = {
      schemaVersion: 1,
      sequence: 1,
      taskId: 'task',
      attemptId: 'attempt',
      workerId: 'worker',
      runtimeKind: 'simulated',
      simulated: true,
      kind: 'started',
    };
    expect(() => store.receive('attempt', 'forged', event)).toThrow(
      'STALE_FENCE',
    );
    expect(store.getOperation('attempt').status).toBe('sending');
    now += 1001;
    open('next');
    expect(() => store.receive('attempt', op.token, event)).toThrow(
      'STALE_FENCE',
    );
  });
  it.each(['wrong_task', 'wrong_sequence', 'receipt'])(
    'rejects invalid %s events and stores a normalized reason',
    (kind) => {
      const op = prepared();
      store.markSending('attempt', op.token);
      const event = {
        schemaVersion: 1,
        sequence: 1,
        taskId: 'task',
        attemptId: 'attempt',
        workerId: 'worker',
        runtimeKind: 'simulated',
        simulated: true,
        kind: 'started',
      };
      const bad =
        kind === 'wrong_task'
          ? { ...event, taskId: 'other' }
          : kind === 'wrong_sequence'
            ? { ...event, sequence: 3 }
            : { ...event, receipts: [] };
      expect(() => store.receive('attempt', op.token, bad)).toThrow(
        'INVALID_EVENT',
      );
      expect(store.getOperation('attempt').reason).toBe('invalid_event');
      expect(store.getTask('task').state).toBe('needs_attention');
    },
  );
  it('returns bounded event replay with monotonic cursors', () => {
    prepared();
    const first = store.events(0, 2);
    expect(first).toHaveLength(2);
    expect(store.events(first[1]!.sequence)).toHaveLength(1);
    expect(() => store.events(-1)).toThrow('INVALID_INPUT');
  });
  it('rolls back a failed migration without changing existing data', () => {
    store.create('create', input);
    store.close();
    expect(
      () =>
        new Store(join(root, 'state.sqlite'), {
          owner: 'next',
          migrations: [
            {
              version: 5,
              sql: 'CREATE TABLE broken(id TEXT); THIS IS INVALID;',
            },
          ],
        }),
    ).toThrow();
    store = open('next');
    expect(store.getTask('task').id).toBe('task');
    expect(store.schemaVersion()).toBe(4);
    const db = new Database(join(root, 'state.sqlite'));
    expect(
      db.prepare("select name from sqlite_master where name='broken'").get(),
    ).toBeUndefined();
    db.close();
  });
  it('rejects future schema without changing it', () => {
    store.close();
    const db = new Database(join(root, 'state.sqlite'));
    db.pragma('user_version=99');
    db.close();
    expect(() => open('next')).toThrow('SCHEMA_UNSUPPORTED');
  });
});
it('does not migrate a database owned by another live controller', () => {
  expect(
    () =>
      new Store(join(root, 'state.sqlite'), {
        owner: 'second',
        now: () => now,
        migrations: [{ version: 5, sql: 'CREATE TABLE surprise(id TEXT);' }],
      }),
  ).toThrow('LEASE_BUSY');
  expect(store.schemaVersion()).toBe(4);
  const db = new Database(join(root, 'state.sqlite'));
  expect(
    db.prepare("select name from sqlite_master where name='surprise'").get(),
  ).toBeUndefined();
  db.close();
});
it('holds the workspace until verification finishes', () => {
  const op = prepared();
  store.markSending('attempt', op.token);
  const base = {
    schemaVersion: 1,
    taskId: 'task',
    attemptId: 'attempt',
    workerId: 'worker',
    runtimeKind: 'simulated',
    simulated: true,
  };
  store.receive('attempt', op.token, { ...base, sequence: 1, kind: 'started' });
  store.receive('attempt', op.token, {
    ...base,
    sequence: 2,
    kind: 'completed',
    treeHash: 'a'.repeat(64),
    artifactSetHash: 'b'.repeat(64),
  });
  store.create('create2', { ...input, id: 'task2' });
  store.queue('queue2', 'task2', 0);
  const other = {
    taskId: 'task2',
    workerId: 'worker2',
    attemptId: 'attempt2',
    workspaceId: 'workspace',
    sessionId: 'session2',
    scenario: 'success' as const,
    expectedVersion: 1,
  };
  expect(() => store.dispatch('dispatch2', other)).toThrow('LEASE_BUSY');
  store.finishVerification('task', undefined, true);
  expect(store.dispatch('dispatch2', other).status).toBe('prepared');
});
it('publishes artifacts before references and retains content after failed reference commit', async () => {
  const { ArtifactStore } = await import('./artifacts.ts');
  const artifacts = new ArtifactStore(join(root, 'objects'));
  store.create('create', input);
  const hash = store.recordArtifact('task', artifacts, Buffer.from('evidence'));
  expect(store.artifactHashes()).toEqual([hash]);
  expect(artifacts.get(hash).toString()).toBe('evidence');
  expect(() =>
    store.recordArtifact('missing', artifacts, Buffer.from('unreferenced')),
  ).toThrow('NOT_FOUND');
  expect(store.artifactHashes()).toEqual([hash]);
});
it('retains reservations when verification shutdown is uncertain', () => {
  const op = prepared();
  store.markSending('attempt', op.token);
  const base = {
    schemaVersion: 1,
    taskId: 'task',
    attemptId: 'attempt',
    workerId: 'worker',
    runtimeKind: 'simulated',
    simulated: true,
  };
  store.receive('attempt', op.token, { ...base, sequence: 1, kind: 'started' });
  store.receive('attempt', op.token, {
    ...base,
    sequence: 2,
    kind: 'completed',
    treeHash: 'a'.repeat(64),
    artifactSetHash: 'b'.repeat(64),
  });
  store.finishVerification('task', undefined);
  expect(store.getOperation('attempt').status).toBe('unknown');
  expect(() =>
    store.queue('retry', 'task', store.getTask('task').rowVersion),
  ).toThrow('UNRESOLVED_OPERATION');
  store.reconcile('attempt', 'stopped');
  expect(
    store.queue('retry', 'task', store.getTask('task').rowVersion).state,
  ).toBe('queued');
});
it('finds the latest event of a kind for a task beyond the first page', () => {
  store.create('create', input);
  for (let i = 0; i < 150; i++)
    store.create('create-' + i, { ...input, id: 't' + i });
  store.queue('queue', 'task', 0);
  expect(store.events(0).length).toBe(100);
  const last = store.lastEvent('task', 'task.state_changed');
  expect(last?.taskId).toBe('task');
  expect(
    store
      .events(0, 1000)
      .filter((e) => e.taskId === 'task' && e.kind === 'task.state_changed')
      .at(-1)?.sequence,
  ).toBe(last?.sequence);
  expect(store.lastEvent('task', 'never')).toBeUndefined();
});
