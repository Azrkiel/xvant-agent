import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { NativeVerifier } from './native-verifier.ts';
import { NativeReviewController } from './native-review.ts';
let root: string, workspace: string;
let store: Store, objects: ArtifactStore, review: NativeReviewController;
let verifier: NativeVerifier;
let failAt = '';
function open() {
  return new Store(join(root, 'state.sqlite'), {
    owner: 'controller',
    fault: (point) => {
      if (point === failAt) throw new Error('injected');
    },
  });
}
async function verified(
  outcome: 'completed' | 'failed' | 'cancelled' = 'completed',
  code = 'process.exit(0)',
) {
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Offline review',
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Pass'],
  });
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
  if (outcome === 'completed') {
    verifier = new NativeVerifier(
      store,
      objects,
      { workspace },
      { test: { executable: process.execPath, args: ['-e', code] } },
    );
    await verifier.verify('connection', connection.token, { stopped: true });
  }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-native-review-'));
  workspace = join(root, 'work');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'result.txt'), 'reviewed content');
  failAt = '';
  store = open();
  objects = new ArtifactStore(join(root, 'objects'));
  review = new NativeReviewController(store, objects);
});
afterEach(() => {
  verifier?.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
it('accepts only the explicit reviewed offline evidence and audits the actor', async () => {
  await verified();
  const prepared = review.prepare(
    'prepare',
    'connection',
    store.getTask('task').rowVersion,
  );
  expect(store.getTask('task').state).toBe('ready_for_acceptance');
  expect(prepared.classification).toBe('offline');
  expect(review.evidence('connection').receipts[0]?.status).toBe('passed');
  const manifest = JSON.parse(
    review.artifact('connection', prepared.treeHash).toString(),
  );
  expect(review.artifact('connection', manifest.files[0].hash).toString()).toBe(
    'reviewed content',
  );
  expect(() =>
    store.accept('simulated', 'task', prepared.rowVersion),
  ).toThrow();
  const accepted = review.accept('accept', {
    connectionId: 'connection',
    expectedVersion: prepared.rowVersion,
    reviewedEvidenceHash: prepared.evidenceHash,
    actorId: 'reviewer',
    classification: 'offline',
  });
  expect(accepted.state).toBe('accepted');
  expect(accepted.nativeQualification).toMatchObject({
    classification: 'offline',
    runtimeKind: 'codex',
    connectionId: 'connection',
  });
  expect(store.providers.occupied('workspace:workspace')).toBe(false);
  expect(store.events(0).at(-1)).toMatchObject({
    kind: 'native.accepted',
    payload: {
      actorId: 'reviewer',
      evidenceHash: prepared.evidenceHash,
      classification: 'offline',
    },
  });
});
it('deduplicates acceptance across restart without duplicating its audit event', async () => {
  await verified();
  const prepared = review.prepare(
    'prepare',
    'connection',
    store.getTask('task').rowVersion,
  );
  const input = {
    connectionId: 'connection',
    expectedVersion: prepared.rowVersion,
    reviewedEvidenceHash: prepared.evidenceHash,
    actorId: 'reviewer',
    classification: 'offline' as const,
  };
  const accepted = review.accept('accept', input);
  store.close();
  store = open();
  review = new NativeReviewController(store, objects);
  expect(review.accept('accept', input)).toEqual(accepted);
  expect(
    store.events(0).filter((event) => event.kind === 'native.accepted'),
  ).toHaveLength(1);
  expect(() => review.accept('accept', { ...input, actorId: 'other' })).toThrow(
    'CONFLICT',
  );
});
it.each(['failed', 'cancelled'] as const)(
  'refuses %s outcomes',
  async (outcome) => {
    await verified(outcome);
    expect(() =>
      review.prepare('prepare', 'connection', store.getTask('task').rowVersion),
    ).toThrow();
  },
);
it.each([
  'process.exit(1)',
  "require('node:fs').writeFileSync('result.txt','changed')",
])('refuses failed or uncertain verification: %s', async (code) => {
  await verified('completed', code);
  expect(() =>
    review.prepare('prepare', 'connection', store.getTask('task').rowVersion),
  ).toThrow();
});
it('rejects stale versions, wrong evidence digest, missing actor and live classification', async () => {
  await verified();
  const prepared = review.prepare(
    'prepare',
    'connection',
    store.getTask('task').rowVersion,
  );
  const input = {
    connectionId: 'connection',
    expectedVersion: prepared.rowVersion,
    reviewedEvidenceHash: prepared.evidenceHash,
    actorId: 'reviewer',
    classification: 'offline' as const,
  };
  for (const altered of [
    { expectedVersion: 0 },
    { reviewedEvidenceHash: 'f'.repeat(64) },
    { actorId: '' },
    { classification: 'live' },
  ])
    expect(() => review.accept('accept', { ...input, ...altered })).toThrow();
  expect(store.providers.occupied('workspace:workspace')).toBe(true);
});
it('fails closed when a reviewed artifact is corrupted', async () => {
  await verified();
  const prepared = review.prepare(
    'prepare',
    'connection',
    store.getTask('task').rowVersion,
  );
  writeFileSync(join(root, 'objects', prepared.treeHash), 'corrupt');
  expect(() =>
    review.accept('accept', {
      connectionId: 'connection',
      expectedVersion: prepared.rowVersion,
      reviewedEvidenceHash: prepared.evidenceHash,
      actorId: 'reviewer',
      classification: 'offline',
    }),
  ).toThrow('ARTIFACT_CORRUPT');
  expect(store.getTask('task').state).toBe('ready_for_acceptance');
});
it('accepts immutable reviewed artifacts rather than later workspace edits', async () => {
  await verified();
  const prepared = review.prepare(
    'prepare',
    'connection',
    store.getTask('task').rowVersion,
  );
  writeFileSync(join(workspace, 'result.txt'), 'later edit');
  expect(
    review.accept('accept', {
      connectionId: 'connection',
      expectedVersion: prepared.rowVersion,
      reviewedEvidenceHash: prepared.evidenceHash,
      actorId: 'reviewer',
      classification: 'offline',
    }).treeHash,
  ).toBe(prepared.treeHash);
});
it('rolls acceptance state, event and reservation release back together', async () => {
  await verified();
  const prepared = review.prepare(
    'prepare',
    'connection',
    store.getTask('task').rowVersion,
  );
  const input = {
    connectionId: 'connection',
    expectedVersion: prepared.rowVersion,
    reviewedEvidenceHash: prepared.evidenceHash,
    actorId: 'reviewer',
    classification: 'offline' as const,
  };
  failAt = 'native.accept.before_commit';
  expect(() => review.accept('accept', input)).toThrow('injected');
  expect(store.getTask('task').state).toBe('ready_for_acceptance');
  expect(store.providers.occupied('workspace:workspace')).toBe(true);
  expect(
    store.events(0).filter((event) => event.kind === 'native.accepted'),
  ).toEqual([]);
  failAt = '';
  expect(review.accept('accept', input).state).toBe('accepted');
});
it('does not review unrelated objects or accept a reconciled connection', async () => {
  await verified();
  const unrelated = objects.put(Buffer.from('unrelated'));
  expect(() => review.artifact('connection', unrelated)).toThrow('NOT_FOUND');
  store.providers.reconcile('connection', 'stopped');
  expect(() =>
    review.prepare('prepare', 'connection', store.getTask('task').rowVersion),
  ).toThrow();
});
it('preserves a pending immutable review across controller restart', async () => {
  await verified();
  const prepared = review.prepare(
    'prepare',
    'connection',
    store.getTask('task').rowVersion,
  );
  store.close();
  store = open();
  review = new NativeReviewController(store, objects);
  expect(store.recover()).toEqual([]);
  expect(
    review.accept('accept', {
      connectionId: 'connection',
      expectedVersion: prepared.rowVersion,
      reviewedEvidenceHash: prepared.evidenceHash,
      actorId: 'reviewer',
      classification: 'offline',
    }).state,
  ).toBe('accepted');
});
