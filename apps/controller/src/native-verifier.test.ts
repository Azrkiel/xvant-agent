import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import {
  ArtifactStore,
  backupSnapshot,
  restoreSnapshot,
} from '../../../packages/storage/src/artifacts.ts';
import { captureWorkspace } from '../../../packages/storage/src/workspace.ts';
import { NativeVerifier } from './native-verifier.ts';
let root: string;
let workspace: string;
let store: Store;
let verifier: NativeVerifier | undefined;
let objects: ArtifactStore;
let now = 1000;
const input = {
  id: 'task',
  projectId: 'project',
  objective: 'Native fixture',
  requiredCheckIds: ['test'],
  acceptanceCriteria: ['Pass'],
};
function completed(
  outcome: 'completed' | 'failed' | 'cancelled' = 'completed',
) {
  store.create('create', input);
  store.queue('queue', 'task', 0);
  const connection = store.providers.reserve({
    connectionId: 'connection',
    taskId: 'task',
    attemptId: 'attempt',
    workspaceId: 'workspace',
    expectedVersion: 1,
    classification: 'offline',
    worker: {
      id: 'worker',
      alias: 'worker',
      runtimeKind: 'codex',
      hostId: 'host',
      endpointId: 'endpoint',
      nativeSessionId: 'thread:1',
      runtimeVersion: 'fixture',
      adapterVersion: 'v1',
      mode: 'managed',
      quotaGroupId: 'account',
    },
  });
  store.providers.bindRun('connection', connection.token, 'turn:1');
  store.providers.finish('connection', connection.token, 'turn:1', outcome);
  return connection;
}
function host(code = 'process.exit(0)', timeoutMs = 2000) {
  verifier = new NativeVerifier(
    store,
    objects,
    { workspace },
    { test: { executable: process.execPath, args: ['-e', code] } },
    { timeoutMs },
  );
  return verifier;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-native-verify-'));
  workspace = join(root, 'work');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'output.txt'), 'real result');
  now = 1000;
  store = new Store(join(root, 'state.sqlite'), {
    owner: 'controller',
    now: () => now,
    leaseMs: 1000,
  });
  objects = new ArtifactStore(join(root, 'objects'));
});
afterEach(() => {
  verifier?.stop();
  verifier = undefined;
  store.close();
  rmSync(root, { recursive: true, force: true });
});
it('persists host-generated receipts tied to native identity and real artifact bytes', async () => {
  const connection = completed();
  const result = await host().verify('connection', connection.token, {
    stopped: true,
  });
  expect(result.status).toBe('passed');
  if (result.status === 'unknown') throw new Error('Expected evidence');
  expect(result.evidence).toMatchObject({
    runtimeKind: 'codex',
    classification: 'offline',
    connectionId: 'connection',
    workspaceId: 'workspace',
    nativeSessionId: 'thread:1',
    nativeRunId: 'turn:1',
    taskId: 'task',
    attemptId: 'attempt',
    workRevision: 0,
  });
  expect(result.evidence?.receipts).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('simulated');
  const manifest = JSON.parse(
    objects.get(result.evidence!.treeHash).toString(),
  );
  expect(objects.get(manifest.files[0].hash).toString()).toBe('real result');
  expect(store.artifactHashes()).toContain(result.evidence!.treeHash);
  store.close();
  store = new Store(join(root, 'state.sqlite'), {
    owner: 'next',
    now: () => 3000,
  });
  expect(store.providers.get('connection').verification).toEqual(result);
  expect(store.getTask('task').state).toBe('needs_attention');
  expect(() =>
    store.accept('accept', 'task', store.getTask('task').rowVersion),
  ).toThrow();
});
it.each(['failed', 'cancelled'] as const)(
  'refuses %s native outcomes before running checks',
  async (outcome) => {
    const connection = completed(outcome);
    await expect(
      host().verify('connection', connection.token, { stopped: true }),
    ).rejects.toThrow('VERIFICATION_UNAVAILABLE');
  },
);
it('requires host-confirmed shutdown and a registered workspace', async () => {
  const connection = completed();
  await expect(
    host().verify('connection', connection.token, { stopped: false }),
  ).rejects.toThrow('SHUTDOWN_UNCONFIRMED');
  verifier = new NativeVerifier(
    store,
    objects,
    {},
    { test: { executable: process.execPath, args: [] } },
  );
  await expect(
    verifier.verify('connection', connection.token, { stopped: true }),
  ).rejects.toThrow('WORKSPACE_UNAVAILABLE');
});
it('fails checks without retaining their output as evidence', async () => {
  const connection = completed();
  const result = await host("console.log('secret'); process.exit(1)").verify(
    'connection',
    connection.token,
    { stopped: true },
  );
  expect(result.status).toBe('failed');
  if (result.status === 'unknown') throw new Error('Expected evidence');
  expect(result.evidence?.receipts[0]?.status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('keeps a redacted output tail of failing checks for repairs, outside evidence', async () => {
  const connection = completed();
  const v = host(
    "console.log('x'.repeat(5000)); console.error('token sk-ant-' + 'a'.repeat(30) + ' expected 2 got 3'); process.exit(1)",
  );
  const result = await v.verify('connection', connection.token, {
    stopped: true,
  });
  expect(result.status).toBe('failed');
  const output = v.checkOutput('connection');
  expect(Object.keys(output)).toEqual(['test']);
  expect(output.test).toContain('expected 2 got 3');
  expect(output.test).toContain('[REDACTED]');
  expect(output.test).not.toContain('sk-ant-');
  expect(output.test!.length).toBeLessThanOrEqual(4001);
  expect(JSON.stringify(result)).not.toContain('expected 2 got 3');
  expect(JSON.stringify(store.providers.get('connection'))).not.toContain(
    'expected 2 got 3',
  );
});
it('keeps no output tail for passing checks', async () => {
  const connection = completed();
  const v = host("console.log('fine'); process.exit(0)");
  await v.verify('connection', connection.token, { stopped: true });
  expect(v.checkOutput('connection')).toEqual({});
  expect(v.checkOutput('unknown')).toEqual({});
});
it('rejects evidence if a check changes workspace bytes', async () => {
  const connection = completed();
  const result = await host(
    "require('node:fs').writeFileSync('output.txt','changed')",
  ).verify('connection', connection.token, { stopped: true });
  expect(result).toMatchObject({
    status: 'unknown',
    reason: 'WORKSPACE_CHANGED',
  });
  expect(result).not.toHaveProperty('evidence');
});
it('retains reservations after verifier timeout', async () => {
  const connection = completed();
  const result = await host('setInterval(() => {}, 1000)', 100).verify(
    'connection',
    connection.token,
    { stopped: true },
  );
  expect(result.status).toBe('unknown');
  expect(() =>
    store.queue('retry', 'task', store.getTask('task').rowVersion),
  ).toThrow('UNRESOLVED_OPERATION');
});
it('fences stale verifier completion after lease takeover', async () => {
  const connection = completed();
  now = 3000;
  const next = new Store(join(root, 'state.sqlite'), {
    owner: 'next',
    now: () => now,
  });
  try {
    await expect(
      host().verify('connection', connection.token, { stopped: true }),
    ).rejects.toThrow('STALE_FENCE');
  } finally {
    next.close();
  }
});
it('recovery abandons interrupted verification without releasing reservations', () => {
  const connection = completed();
  store.providers.beginVerification('connection', connection.token);
  store.close();
  store = new Store(join(root, 'state.sqlite'), {
    owner: 'next',
    now: () => 3000,
  });
  expect(store.recover()).toEqual(['attempt']);
  expect(store.providers.get('connection').status).toBe('unknown');
  expect(() =>
    store.queue('retry', 'task', store.getTask('task').rowVersion),
  ).toThrow('UNRESOLVED_OPERATION');
});
it('does not release the workspace or accept after successful verification', async () => {
  const connection = completed();
  await host().verify('connection', connection.token, { stopped: true });
  expect(store.providers.occupied('workspace:workspace')).toBe(true);
  store.providers.reconcile('connection', 'stopped');
  expect(store.providers.occupied('workspace:workspace')).toBe(false);
  expect(() =>
    store.accept('accept', 'task', store.getTask('task').rowVersion),
  ).toThrow();
});
it('rejects missing checks before changing durable state', async () => {
  const connection = completed();
  verifier = new NativeVerifier(store, objects, { workspace }, {});
  await expect(
    verifier.verify('connection', connection.token, { stopped: true }),
  ).rejects.toThrow('VERIFIER_UNAVAILABLE');
  expect(store.providers.get('connection').status).toBe('result_pending');
});
it('does not attest truncated verifier output', async () => {
  const connection = completed();
  const result = await host("process.stdout.write('x'.repeat(70000))").verify(
    'connection',
    connection.token,
    { stopped: true },
  );
  expect(result.status).toBe('unknown');
});
it('does not publish late evidence after ownership changes during a check', async () => {
  const connection = completed();
  const run = host('setTimeout(() => process.exit(0), 400)').verify(
    'connection',
    connection.token,
    { stopped: true },
  );
  const rejected = expect(run).rejects.toThrow('STALE_FENCE');
  await vi.waitFor(() =>
    expect(store.providers.get('connection').status).toBe('verifying'),
  );
  now = 3000;
  const next = new Store(join(root, 'state.sqlite'), {
    owner: 'next',
    now: () => now,
  });
  try {
    await rejected;
    expect(next.recover()).toEqual(['attempt']);
    expect(next.providers.get('connection').verification).toBeUndefined();
  } finally {
    next.close();
  }
});
it('restores verified receipts together with every referenced artifact', async () => {
  const connection = completed();
  const result = await host().verify('connection', connection.token, {
    stopped: true,
  });
  if (result.status === 'unknown') throw new Error('Expected evidence');
  await backupSnapshot(store, objects, join(root, 'backup'));
  await restoreSnapshot(join(root, 'backup'), join(root, 'restore'));
  const restored = new Store(join(root, 'restore', 'state.sqlite'), {
    owner: 'restore',
    now: () => 3000,
  });
  try {
    expect(restored.providers.get('connection').verification).toEqual(result);
    const copy = new ArtifactStore(join(root, 'restore', 'artifacts'));
    for (const hash of restored.artifactHashes())
      expect(copy.get(hash).length).toBeGreaterThan(0);
  } finally {
    restored.close();
  }
});
it.each(['binding', 'receipt', 'missing_check', 'duplicate_check', 'outcome'])(
  'rejects forged %s evidence before committing references',
  (kind) => {
    const connection = completed();
    store.providers.beginVerification('connection', connection.token);
    const snapshot = captureWorkspace(workspace, objects);
    const binding = {
      taskId: 'task',
      attemptId: 'attempt',
      workRevision: 0,
      generation: connection.generation,
      connectionId: 'connection',
      workspaceId: 'workspace',
      hostId: 'host',
      runtimeKind: 'codex',
      classification: 'offline',
      nativeSessionId: 'thread:1',
      nativeRunId: 'turn:1',
      treeHash: snapshot.treeHash,
      artifactSetHash: snapshot.artifactSetHash,
      workspaceRootHash: snapshot.workspaceRootHash,
    };
    const receipt = {
      ...binding,
      checkId: 'test',
      commandHash: 'a'.repeat(64),
      status: 'passed',
    };
    const evidence = { ...binding, receipts: [receipt] };
    if (kind === 'binding') {
      evidence.workRevision = 1;
      receipt.workRevision = 1;
    }
    if (kind === 'receipt') receipt.nativeRunId = 'forged';
    if (kind === 'missing_check') receipt.checkId = 'other';
    if (kind === 'duplicate_check') evidence.receipts.push(receipt);
    if (kind === 'outcome') receipt.status = 'failed';
    expect(() =>
      store.providers.finishVerification(
        'connection',
        connection.token,
        { status: 'passed', evidence },
        objects,
      ),
    ).toThrow();
    expect(store.artifactHashes()).toEqual([]);
    expect(store.providers.get('connection').status).toBe('verifying');
  },
);
it('stops admission after controller shutdown', async () => {
  const connection = completed();
  const controller = host();
  controller.stop();
  await expect(
    controller.verify('connection', connection.token, { stopped: true }),
  ).rejects.toThrow('CONTROLLER_STOPPED');
});
it('retains uncertainty for an unavailable executable', async () => {
  const connection = completed();
  verifier = new NativeVerifier(
    store,
    objects,
    { workspace },
    { test: { executable: join(root, 'missing.exe'), args: [] } },
  );
  expect(
    (await verifier.verify('connection', connection.token, { stopped: true }))
      .status,
  ).toBe('unknown');
});
