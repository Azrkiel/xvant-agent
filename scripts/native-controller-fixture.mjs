import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { OfflineNativeController } from '../apps/controller/src/native-offline.ts';
import { versions } from '../packages/adapters/src/providers/native-profiles.ts';

const kind = process.argv[2];
if (kind !== 'claude' && kind !== 'opencode') throw new Error('INVALID_INPUT');
const root = mkdtempSync(join(tmpdir(), 'xvant-native-controller-demo-'));
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
  controller = new OfflineNativeController(
    store,
    new ArtifactStore(join(root, 'objects')),
    { workspace },
    {
      check: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
    },
  );
  const task = await controller.run(
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
        runtimeKind: kind,
        hostId: 'host',
        endpointId: 'fixture',
        nativeSessionId: 'session-1',
        runtimeVersion: versions[kind],
        adapterVersion: 'v1',
        mode: 'managed',
        quotaGroupId: 'account',
      },
    },
    'permission',
  );
  const connection = store.providers.get('connection');
  console.log(
    JSON.stringify({
      classification: 'offline',
      liveProvidersTested: [],
      kind,
      state: task.state,
      verification: connection.verification?.status,
      journalEntries: store.providers.entries('connection').length,
      activeCount: controller.activeCount,
      accepted: store
        .events(0)
        .some((event) => event.kind === 'native.accepted'),
    }),
  );
  if (task.state !== 'ready_for_acceptance') process.exitCode = 1;
} finally {
  controller?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true });
}
