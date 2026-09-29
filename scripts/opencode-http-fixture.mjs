import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { OfflineOpenCodeHttpController } from '../apps/controller/src/opencode-http.ts';
import { versions } from '../packages/adapters/src/providers/native-profiles.ts';

// Owned authenticated loopback endpoint with the fixed synthetic server only.
const scenario = process.argv[2] ?? 'permission';
if (!['permission', 'interrupt', 'no-auth'].includes(scenario))
  throw new Error('INVALID_INPUT');
const root = mkdtempSync(join(tmpdir(), 'xvant-opencode-http-demo-'));
let store, controller;
try {
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'result.txt'), 'offline fixture');
  store = new Store(join(root, 'state.sqlite'), { owner: 'fixture' });
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Read fixture',
    requiredCheckIds: ['check'],
    acceptanceCriteria: ['Pass'],
  });
  store.queue('queue', 'task', 0);
  controller = new OfflineOpenCodeHttpController(
    store,
    new ArtifactStore(join(root, 'objects')),
    { workspace },
    {
      check: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
    },
  );
  const pending = controller.run(
    {
      connectionId: 'connection',
      taskId: 'task',
      attemptId: 'attempt',
      workspaceId: 'workspace',
      expectedVersion: 1,
      classification: 'offline',
      worker: {
        id: 'worker',
        alias: 'worker',
        runtimeKind: 'opencode',
        hostId: 'host',
        endpointId: 'loopback',
        nativeSessionId: 'session-1',
        runtimeVersion: versions.opencode,
        adapterVersion: 'v1',
        mode: 'managed',
        quotaGroupId: 'account',
      },
    },
    scenario,
  );
  let admission = null;
  for (let tries = 0; scenario === 'interrupt' && !admission; tries++) {
    try {
      admission = controller.interrupt('connection', 'operator').status;
    } catch (error) {
      if (error.message !== 'NOT_INTERRUPTIBLE' || tries >= 1000) throw error;
      await new Promise((done) => setTimeout(done, 5));
    }
  }
  const task = await pending;
  const connection = store.providers.get('connection');
  console.log(
    JSON.stringify({
      classification: 'offline',
      liveProvidersTested: [],
      scenario,
      state: task.state,
      status: connection.status,
      outcome: connection.outcome,
      verification: connection.verification?.status,
      endpointBound: connection.endpoint !== undefined,
      loopback: /^http:\/\/127\.0\.0\.1:\d+$/.test(
        connection.endpoint?.origin ?? '',
      ),
      interruptAdmission: admission,
      methods: store.providers
        .entries('connection')
        .filter((entry) => entry.direction === 'out')
        .map((entry) => entry.method),
      activeCount: controller.activeCount,
      accepted: store
        .events(0)
        .some((event) => event.kind === 'native.accepted'),
    }),
  );
  const expected = {
    permission:
      task.state === 'ready_for_acceptance' &&
      connection.endpoint !== undefined,
    interrupt: connection.outcome === 'cancelled',
    'no-auth':
      connection.status === 'unknown' && connection.endpoint === undefined,
  }[scenario];
  if (!expected) process.exitCode = 1;
} finally {
  controller?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true });
}
