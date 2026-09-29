import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from './store.ts';
import { ArtifactStore, backupSnapshot, restoreSnapshot } from './artifacts.ts';
import { durableCodexChannel } from '../../adapters/src/codex/durable.ts';

const worker = {
  id: 'worker',
  alias: 'codex_one',
  runtimeKind: 'codex' as const,
  hostId: 'host',
  endpointId: 'endpoint',
  nativeSessionId: 'native/thread:1',
  runtimeVersion: '0.158.0-alpha.2.1',
  adapterVersion: 'v1',
  mode: 'managed' as const,
  quotaGroupId: 'account',
};
const spec = {
  connectionId: 'connection',
  taskId: 'task',
  attemptId: 'attempt',
  workspaceId: 'workspace',
  expectedVersion: 1,
  worker,
  classification: 'offline' as const,
};
const task = {
  id: 'task',
  projectId: 'project',
  objective: 'Fixture',
  requiredCheckIds: ['test'],
  acceptanceCriteria: ['Pass'],
};
let root: string;
let store: Store;
let now: number;
const stores: Store[] = [];
function open(fault?: (point: string) => void) {
  const value = new Store(join(root, 'state.sqlite'), {
    owner: 'controller',
    now: () => now,
    leaseMs: 500,
    ...(fault ? { fault } : {}),
  });
  stores.push(value);
  return value;
}
function queued(id = 'task') {
  store.create('create_' + id, { ...task, id });
  store.queue('queue_' + id, id, 0);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-native-'));
  now = 1000;
  store = open();
  queued();
});
function creating() {
  const connection = store.providers.reserve(spec);
  store.providers.recordIntent('connection', connection.token, {
    id: 1,
    method: 'thread/start',
    frame: '{"id":1,"method":"thread/start","params":{}}\n',
  });
  return connection;
}
it('binds only a provisional OpenCode creation reservation before dispatch', () => {
  const connection = store.providers.reserve({
    ...spec,
    worker: {
      ...worker,
      runtimeKind: 'opencode',
      nativeSessionId: 'pending:connection',
    },
  });
  store.providers.recordIntent('connection', connection.token, {
    id: 1,
    method: 'session/create',
    frame: '{"method":"POST","path":"/session"}\n',
  });
  store.providers.bindSession('connection', connection.token, 'created-1');
  expect(store.providers.get('connection').worker.nativeSessionId).toBe(
    'created-1',
  );
  expect(store.providers.get('connection').sessionBound).toBe(true);
  expect(() =>
    store.providers.bindSession('connection', connection.token, 'other'),
  ).toThrow('CONFLICT');
});
it.each(['missing', 'wrong-provider', 'after-dispatch', 'not-provisional'])(
  'rejects invalid OpenCode binding: %s',
  (mode) => {
    const connection = store.providers.reserve({
      ...spec,
      worker: {
        ...worker,
        runtimeKind: 'opencode',
        nativeSessionId:
          mode === 'not-provisional' ? 'existing' : 'pending:connection',
      },
    });
    if (mode !== 'missing')
      store.providers.recordIntent('connection', connection.token, {
        id: 1,
        method: mode === 'wrong-provider' ? 'thread/start' : 'session/create',
        frame: '{}\n',
      });
    if (mode === 'after-dispatch')
      store.providers.recordIntent('connection', connection.token, {
        id: 2,
        method: 'fixture/start',
        frame: '{}\n',
      });
    expect(() =>
      store.providers.bindSession('connection', connection.token, 'created-1'),
    ).toThrow('CONFLICT');
    expect(store.providers.get('connection').worker.nativeSessionId).toBe(
      mode === 'not-provisional' ? 'existing' : 'pending:connection',
    );
  },
);
it('atomically binds a created session before a turn and retains it across recovery', () => {
  const connection = creating();
  store.providers.bindSession('connection', connection.token, 'created-1');
  expect(store.providers.get('connection').worker.nativeSessionId).toBe(
    'created-1',
  );
  expect(
    store.providers.occupied(
      'native:' + JSON.stringify(['codex', 'host', worker.nativeSessionId]),
    ),
  ).toBe(false);
  expect(
    store.providers.occupied(
      'native:' + JSON.stringify(['codex', 'host', 'created-1']),
    ),
  ).toBe(true);
  expect(() =>
    store.providers.bindSession('connection', connection.token, 'other'),
  ).toThrow('CONFLICT');
  store.close();
  now = 2000;
  store = open();
  store.recover();
  expect(store.providers.get('connection')).toMatchObject({
    status: 'unknown',
    worker: { nativeSessionId: 'created-1' },
  });
  expect(
    store.providers.occupied(
      'native:' + JSON.stringify(['codex', 'host', 'created-1']),
    ),
  ).toBe(true);
});
it('rejects session rebinding without a creation intent, after turn dispatch or with a stale token', () => {
  const connection = store.providers.reserve(spec);
  expect(() =>
    store.providers.bindSession('connection', connection.token, 'created-1'),
  ).toThrow('CONFLICT');
  store.providers.recordIntent('connection', connection.token, {
    id: 1,
    method: 'thread/start',
    frame: '{"id":1,"method":"thread/start","params":{}}\n',
  });
  expect(() =>
    store.providers.bindSession('connection', 'wrong', 'created-1'),
  ).toThrow('STALE_FENCE');
  store.providers.recordIntent('connection', connection.token, {
    id: 2,
    method: 'turn/start',
    frame: '{"id":2,"method":"turn/start","params":{}}\n',
  });
  expect(() =>
    store.providers.bindSession('connection', connection.token, 'created-1'),
  ).toThrow('CONFLICT');
});
it('does not steal another connection session or lose the original reservation', () => {
  const connection = creating();
  queued('other');
  store.providers.reserve({
    ...spec,
    connectionId: 'other',
    taskId: 'other',
    attemptId: 'other',
    workspaceId: 'other',
    worker: { ...worker, id: 'other', nativeSessionId: 'created-1' },
  });
  expect(() =>
    store.providers.bindSession('connection', connection.token, 'created-1'),
  ).toThrow('LEASE_BUSY');
  expect(store.providers.get('connection').worker.nativeSessionId).toBe(
    worker.nativeSessionId,
  );
  expect(
    store.providers.occupied(
      'native:' + JSON.stringify(['codex', 'host', worker.nativeSessionId]),
    ),
  ).toBe(true);
});
it('rolls back session binding with its reservation update', () => {
  store.close();
  store = open((point) => {
    if (point === 'provider.session.before_commit') throw new Error('disk');
  });
  const connection = creating();
  expect(() =>
    store.providers.bindSession('connection', connection.token, 'created-1'),
  ).toThrow('disk');
  expect(store.providers.get('connection').worker.nativeSessionId).toBe(
    worker.nativeSessionId,
  );
  expect(
    store.providers.occupied(
      'native:' + JSON.stringify(['codex', 'host', 'created-1']),
    ),
  ).toBe(false);
  expect(
    store.providers.occupied(
      'native:' + JSON.stringify(['codex', 'host', worker.nativeSessionId]),
    ),
  ).toBe(true);
});
afterEach(() => {
  for (const value of stores.splice(0)) value.close();
  rmSync(root, { recursive: true, force: true });
});

it('persists exact intent before pipe write and reply metadata before delivery', async () => {
  const connection = store.providers.reserve(spec);
  const channel = durableCodexChannel(store, connection, {
    write: async (frame) => {
      expect(store.providers.entries('connection')[0]?.frame).toBe(frame);
      channel.receive(
        Buffer.from('{"id":1,"result":{"secret":"not retained"}}\n'),
      );
    },
  });
  await expect(
    channel.request('turn/start', { input: 'fixture' }),
  ).resolves.toEqual({ secret: 'not retained' });
  const entries = store.providers.entries('connection');
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({ direction: 'in', rpcId: 1 });
  expect(JSON.stringify(entries)).not.toContain('not retained');
  channel.close();
  expect(store.providers.get('connection').status).toBe('unknown');
  expect(store.getTask('task').state).toBe('needs_attention');
});
it('does not deliver a reply or notification when its journal commit fails', async () => {
  store.close();
  store = open((point) => {
    if (point === 'provider.receive.before_commit') throw new Error('disk');
  });
  const connection = store.providers.reserve(spec);
  const callback = vi.fn();
  const channel = durableCodexChannel(store, connection, {
    write: async () => {},
    onMessage: callback,
  });
  const result = channel.request('turn/start', {});
  const rejected = expect(result).rejects.toThrow('STORAGE_UNAVAILABLE');
  await vi.waitFor(() =>
    expect(store.providers.entries('connection')).toHaveLength(1),
  );
  await Promise.resolve();
  expect(() => channel.receive(Buffer.from('{"id":1,"result":{}}\n'))).toThrow(
    'STORAGE_UNAVAILABLE',
  );
  await rejected;
  expect(callback).not.toHaveBeenCalled();
  expect(store.providers.entries('connection')).toHaveLength(1);
  expect(channel.uncertainIds).toEqual([1]);
});
it('does not write when outgoing persistence fails', async () => {
  store.close();
  store = open((point) => {
    if (point === 'provider.send.before_commit') throw new Error('disk');
  });
  const connection = store.providers.reserve(spec);
  const write = vi.fn(async () => {});
  const channel = durableCodexChannel(store, connection, { write });
  await expect(channel.request('turn/start', {})).rejects.toThrow(
    'STORAGE_UNAVAILABLE',
  );
  expect(write).not.toHaveBeenCalled();
  expect(store.providers.entries('connection')).toEqual([]);
});
it('fences the old owner and rejects old connection reuse after recovery', async () => {
  const connection = store.providers.reserve(spec);
  now += 501;
  const next = open();
  const write = vi.fn(async () => {});
  const channel = durableCodexChannel(store, connection, { write });
  await expect(channel.request('turn/start', {})).rejects.toThrow(
    'STORAGE_UNAVAILABLE',
  );
  expect(write).not.toHaveBeenCalled();
  expect(next.recover()).toEqual(['attempt']);
  expect(next.recover()).toEqual([]);
  expect(() =>
    next.providers.assertWritable('connection', connection.token),
  ).toThrow('STALE_FENCE');
  expect(() =>
    next.queue('retry', 'task', next.getTask('task').rowVersion),
  ).toThrow('UNRESOLVED_OPERATION');
  next.providers.reconcile('connection', 'stopped');
  expect(
    next.queue('retry', 'task', next.getTask('task').rowVersion).state,
  ).toBe('queued');
});
it.each(['workspace', 'worker', 'session'] as const)(
  'retains %s reservation after a native terminal result',
  (resource) => {
    const connection = store.providers.reserve(spec);
    store.providers.bindRun('connection', connection.token, 'turn:1');
    expect(() =>
      store.providers.finish(
        'connection',
        connection.token,
        'wrong',
        'completed',
      ),
    ).toThrow('INVALID_EVENT');
    store.providers.finish(
      'connection',
      connection.token,
      'turn:1',
      'completed',
    );
    expect(store.providers.get('connection').status).toBe('result_pending');
    expect(store.getTask('task').state).toBe('needs_attention');
    queued('other');
    const other = {
      ...spec,
      connectionId: 'other',
      attemptId: 'other',
      taskId: 'other',
      workspaceId: resource === 'workspace' ? 'workspace' : 'other',
      worker: {
        ...worker,
        id: resource === 'worker' ? 'worker' : 'other',
        endpointId: 'renamed',
        nativeSessionId:
          resource === 'session' ? worker.nativeSessionId : 'other',
      },
    };
    expect(() => store.providers.reserve(other)).toThrow('LEASE_BUSY');
    store.providers.reconcile('connection', 'stopped');
    expect(store.providers.reserve(other).status).toBe('open');
  },
);
it('prevents native and simulated workers from using the same workspace', () => {
  store.providers.reserve(spec);
  queued('other');
  expect(() =>
    store.dispatch('dispatch', {
      taskId: 'other',
      attemptId: 'other',
      workerId: 'other',
      workspaceId: 'workspace',
      sessionId: 'other',
      scenario: 'success',
      expectedVersion: 1,
    }),
  ).toThrow('LEASE_BUSY');
});
it('prevents native dispatch into a simulated reservation', () => {
  store.dispatch('dispatch', {
    taskId: 'task',
    attemptId: 'simulated',
    workerId: 'simulated',
    workspaceId: 'workspace',
    sessionId: 'simulated',
    scenario: 'success',
    expectedVersion: 1,
  });
  queued('other');
  expect(() => store.providers.reserve({ ...spec, taskId: 'other' })).toThrow(
    'LEASE_BUSY',
  );
});
it('does not enable live or attached execution through the journal', () => {
  expect(() =>
    store.providers.reserve({ ...spec, classification: 'live' }),
  ).toThrow();
  expect(() =>
    store.providers.reserve({
      ...spec,
      worker: { ...worker, mode: 'attached-control' },
    }),
  ).toThrow();
  expect(store.getTask('task').state).toBe('queued');
});
it('restores provider records and reservations in a verified snapshot', async () => {
  const connection = store.providers.reserve(spec);
  const channel = durableCodexChannel(store, connection, {
    write: async () => {},
  });
  await channel.notify('initialized', {});
  channel.close();
  await backupSnapshot(
    store,
    new ArtifactStore(join(root, 'objects')),
    join(root, 'backup'),
  );
  await restoreSnapshot(join(root, 'backup'), join(root, 'restored'));
  const restored = new Store(join(root, 'restored', 'state.sqlite'), {
    owner: 'restored',
    now: () => 2000,
  });
  stores.push(restored);
  expect(restored.providers.entries('connection')).toHaveLength(1);
  expect(restored.providers.get('connection').status).toBe('unknown');
  expect(() =>
    restored.queue('retry', 'task', restored.getTask('task').rowVersion),
  ).toThrow('UNRESOLVED_OPERATION');
});
it('migrates an existing v1 database without losing its tasks', () => {
  store.close();
  const db = new Database(join(root, 'state.sqlite'));
  db.exec(
    'DROP TABLE provider_entries; DROP TABLE provider_reservations; DROP TABLE provider_connections; PRAGMA user_version=1',
  );
  db.close();
  store = open();
  expect(store.schemaVersion()).toBe(2);
  expect(store.getTask('task').state).toBe('queued');
  expect(store.providers.reserve(spec).workRevision).toBe(0);
});
it('rejects replayed RPC IDs and attempts even after trusted reconciliation', async () => {
  const connection = store.providers.reserve(spec);
  const channel = durableCodexChannel(store, connection, {
    write: async () => {},
  });
  await channel.notify('initialized', {});
  const another = durableCodexChannel(store, connection, {
    write: async () => {
      throw new Error('must not write');
    },
  });
  await expect(another.notify('initialized', {})).rejects.toThrow(
    'STORAGE_UNAVAILABLE',
  );
  channel.close();
  store.providers.reconcile('connection', 'stopped');
  store.queue('retry', 'task', store.getTask('task').rowVersion);
  expect(() =>
    store.providers.reserve({
      ...spec,
      connectionId: 'another',
      expectedVersion: store.getTask('task').rowVersion,
    }),
  ).toThrow('DUPLICATE_IDENTITY');
});
it('does not clear uncertainty with a late terminal result', () => {
  const connection = store.providers.reserve(spec);
  store.providers.bindRun('connection', connection.token, 'turn:1');
  store.providers.unknown('connection', connection.token);
  expect(() =>
    store.providers.finish(
      'connection',
      connection.token,
      'turn:1',
      'completed',
    ),
  ).toThrow('UNRESOLVED_OPERATION');
  expect(store.providers.get('connection').status).toBe('unknown');
});
it('journals notifications before exposing them and blocks delivery on storage failure', () => {
  let failReceive = false;
  store.close();
  store = open((point) => {
    if (failReceive && point === 'provider.receive.before_commit')
      throw new Error('disk');
  });
  const connection = store.providers.reserve(spec);
  const seen: string[] = [];
  const channel = durableCodexChannel(store, connection, {
    write: async () => {},
    onMessage: (message) => {
      expect(store.providers.entries('connection').at(-1)?.method).toBe(
        message.method,
      );
      seen.push(message.method);
    },
  });
  channel.receive(Buffer.from('{"method":"turn/started","params":{}}\n'));
  failReceive = true;
  expect(() =>
    channel.receive(Buffer.from('{"method":"turn/completed","params":{}}\n')),
  ).toThrow('STORAGE_UNAVAILABLE');
  expect(seen).toEqual(['turn/started']);
  expect(store.providers.entries('connection')).toHaveLength(1);
});
it('bounds journal growth and poisons the connection at the limit', () => {
  const connection = store.providers.reserve(spec);
  const channel = durableCodexChannel(store, connection, {
    write: async () => {},
  });
  const bytes = Buffer.from('{"method":"output"}\n');
  for (let index = 0; index < 4096; index++) channel.receive(bytes);
  expect(() => channel.receive(bytes)).toThrow('STORAGE_UNAVAILABLE');
  expect(store.providers.entries('connection')).toHaveLength(4096);
  expect(store.providers.get('connection').status).toBe('unknown');
}, 15000);
it('restores a legacy v1 snapshot then migrates it on open', async () => {
  store.close();
  const db = new Database(join(root, 'state.sqlite'));
  db.exec(
    'DROP TABLE provider_entries; DROP TABLE provider_reservations; DROP TABLE provider_connections; PRAGMA user_version=1',
  );
  try {
    await backupSnapshot(
      {
        backup: async (path) => {
          await db.backup(path);
        },
      },
      new ArtifactStore(join(root, 'objects')),
      join(root, 'legacy'),
    );
  } finally {
    db.close();
  }
  await restoreSnapshot(join(root, 'legacy'), join(root, 'restored'));
  const restored = new Store(join(root, 'restored', 'state.sqlite'), {
    owner: 'restored',
    now: () => 2000,
  });
  stores.push(restored);
  expect(restored.schemaVersion()).toBe(2);
  expect(restored.getTask('task').state).toBe('queued');
});
it.each(['completed', 'cancelled', 'failed'] as const)(
  'retains terminal outcome %s and reconciliation evidence across restart',
  (outcome) => {
    const connection = store.providers.reserve(spec);
    store.providers.bindRun('connection', connection.token, 'turn:1');
    store.providers.finish('connection', connection.token, 'turn:1', outcome);
    store.providers.reconcile('connection', 'stopped');
    store.close();
    store = open();
    expect(store.providers.get('connection')).toMatchObject({
      outcome,
      reconciliation: { outcome: 'stopped', generation: connection.generation },
    });
    expect(store.getTask('task').state).toBe('needs_attention');
  },
);
const native = {
  ...spec,
  worker: { ...worker, runtimeKind: 'opencode' as const, runtimeVersion: '1' },
};
/** Codex binds its turn at dispatch; Claude/OpenCode bind a message at the result. */
function dispatched(kind: 'codex' | 'opencode' = 'codex') {
  const connection = store.providers.reserve(kind === 'codex' ? spec : native);
  store.providers.recordIntent('connection', connection.token, {
    id: 1,
    method: kind === 'codex' ? 'turn/start' : 'fixture/start',
    frame: '{}\n',
  });
  if (kind === 'codex')
    store.providers.bindRun('connection', connection.token, 'turn:1');
  return connection;
}
const interrupt = (token: string, actor = 'operator') =>
  store.providers.requestInterrupt('connection', token, actor);
it('admits one durable interrupt request only after turn dispatch', () => {
  const connection = store.providers.reserve(native);
  expect(() => interrupt(connection.token)).toThrow('NOT_INTERRUPTIBLE');
  store.providers.recordIntent('connection', connection.token, {
    id: 1,
    method: 'fixture/start',
    frame: '{"fixture":"start"}\n',
  });
  interrupt(connection.token);
  expect(store.providers.get('connection').interrupt).toEqual({
    actorId: 'operator',
    generation: connection.generation,
  });
  expect(
    store
      .events(0)
      .filter((event) => event.kind === 'provider.interrupt_requested')
      .map((event) => event.payload),
  ).toEqual([
    { connectionId: 'connection', attemptId: 'attempt', actorId: 'operator' },
  ]);
  expect(() => interrupt(connection.token, 'other')).toThrow('CONFLICT');
  store.close();
  store = open();
  expect(store.providers.get('connection').interrupt?.actorId).toBe('operator');
});
it('requires a bound Codex turn before interrupt admission', () => {
  const connection = store.providers.reserve(spec);
  store.providers.recordIntent('connection', connection.token, {
    id: 1,
    method: 'turn/start',
    frame: '{}\n',
  });
  expect(() => interrupt(connection.token)).toThrow('NOT_INTERRUPTIBLE');
  store.providers.bindRun('connection', connection.token, 'turn:1');
  interrupt(connection.token);
  expect(store.providers.get('connection').interrupt?.actorId).toBe('operator');
});
it('rejects interrupt admission after a native terminal result or uncertainty', () => {
  const connection = dispatched('opencode');
  store.providers.bindRun('connection', connection.token, 'assistant-1');
  expect(() => interrupt(connection.token)).toThrow('NOT_INTERRUPTIBLE');
  store.providers.unknown('connection', connection.token);
  expect(() => interrupt(connection.token)).toThrow('UNRESOLVED_OPERATION');
  expect(() => interrupt(connection.token, '')).toThrow();
  expect(store.providers.get('connection').interrupt).toBeUndefined();
});
it('fences interrupt admission after controller takeover', () => {
  const connection = dispatched();
  now += 501;
  const next = open();
  expect(() => interrupt(connection.token)).toThrow('STALE_FENCE');
  expect(() =>
    next.providers.requestInterrupt('connection', connection.token, 'operator'),
  ).toThrow('STALE_FENCE');
  expect(next.providers.get('connection').interrupt).toBeUndefined();
});
it('rolls back interrupt admission with its audit event', () => {
  store.close();
  store = open((point) => {
    if (point === 'provider.interrupt.before_commit')
      throw new Error('DISK_FAILURE');
  });
  const connection = dispatched();
  expect(() =>
    store.providers.requestInterrupt(
      'connection',
      connection.token,
      'operator',
    ),
  ).toThrow('DISK_FAILURE');
  expect(store.providers.get('connection').interrupt).toBeUndefined();
  expect(
    store
      .events(0)
      .some((event) => event.kind === 'provider.interrupt_requested'),
  ).toBe(false);
});
it('cannot record completion after an admitted interrupt', () => {
  const connection = dispatched();
  interrupt(connection.token);
  expect(() =>
    store.providers.finish(
      'connection',
      connection.token,
      'turn:1',
      'completed',
    ),
  ).toThrow('INVALID_EVENT');
  store.providers.finish('connection', connection.token, 'turn:1', 'cancelled');
  expect(store.providers.get('connection')).toMatchObject({
    status: 'result_pending',
    outcome: 'cancelled',
  });
  expect(() =>
    store.providers.beginVerification('connection', connection.token),
  ).toThrow('VERIFICATION_UNAVAILABLE');
});
const quota = {
  code: 'QUOTA_BLOCKED' as const,
  scope: 'quota_group' as const,
  native: 'usageLimitExceeded',
};
function second(id = 'other', quotaGroupId = 'account') {
  queued(id);
  return {
    ...spec,
    connectionId: id,
    taskId: id,
    attemptId: id,
    workspaceId: id,
    worker: { ...worker, id, nativeSessionId: id, quotaGroupId },
  };
}
it('blocks admission for an account group after a quota failure until a trusted clear', () => {
  const connection = dispatched();
  store.providers.recordFailure('connection', connection.token, quota);
  expect(store.providers.get('connection').failure).toEqual(quota);
  expect(store.providers.blocked('account')).toEqual({
    code: 'QUOTA_BLOCKED',
    connectionId: 'connection',
    native: 'usageLimitExceeded',
  });
  const next = second();
  expect(() => store.providers.reserve(next)).toThrow('QUOTA_BLOCKED');
  expect(store.getTask('other').state).toBe('queued');
  store.providers.reserve(second('third', 'separate'));
  store.close();
  store = open();
  expect(() => store.providers.reserve(next)).toThrow('QUOTA_BLOCKED');
  expect(store.providers.clearBlock('account', 'operator')).toBe(1);
  expect(store.providers.blocked('account')).toBeUndefined();
  expect(store.providers.get('connection').failure).toEqual({
    ...quota,
    cleared: {
      actorId: 'operator',
      generation:
        store.providers.get('connection').failure!.cleared!.generation,
    },
  });
  expect(store.providers.reserve(next).status).toBe('open');
  expect(
    store
      .events(0)
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith('provider.quota')),
  ).toEqual(['provider.quota_group_blocked', 'provider.quota_group_cleared']);
  expect(() => store.providers.clearBlock('account', 'operator')).toThrow(
    'NOT_FOUND',
  );
});
it('records attempt-scoped failures without blocking the account group', () => {
  const connection = dispatched();
  store.providers.recordFailure('connection', connection.token, {
    code: 'MODEL_UNAVAILABLE',
    scope: 'attempt',
    native: 'model_not_found',
  });
  store.providers.recordFailure('connection', connection.token, quota);
  expect(store.providers.get('connection').failure?.code).toBe(
    'MODEL_UNAVAILABLE',
  );
  expect(store.providers.blocked('account')).toBeUndefined();
  expect(
    store
      .events(0)
      .filter((event) => event.kind === 'provider.failure_recorded'),
  ).toHaveLength(1);
});
it('blocks on auth failures and fences failure records', () => {
  const connection = dispatched();
  expect(() =>
    store.providers.recordFailure('connection', connection.token, {
      ...quota,
      native: 'has spaces',
    }),
  ).toThrow();
  expect(() =>
    store.providers.recordFailure('connection', 'x'.repeat(64), quota),
  ).toThrow('STALE_FENCE');
  store.providers.recordFailure('connection', connection.token, {
    code: 'AUTH_REQUIRED',
    scope: 'quota_group',
    native: 'unauthorized',
  });
  expect(() => store.providers.reserve(second())).toThrow('AUTH_REQUIRED');
  expect(() => store.providers.clearBlock('account', '')).toThrow();
});
