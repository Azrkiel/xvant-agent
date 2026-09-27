import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Store } from '../../../packages/storage/src/store.ts';
import {
  ArtifactStore,
  backupSnapshot,
  restoreSnapshot,
} from '../../../packages/storage/src/artifacts.ts';
import { DurableController } from './durable.ts';
import { executionCapabilities } from '../../../packages/policy/src/index.ts';
const root = mkdtempSync(join(tmpdir(), 'xvant-demo-'));
let store: Store | undefined;
let controller: DurableController | undefined;
try {
  store = new Store(join(root, 'state.sqlite'), { owner: 'demo' });
  const artifacts = new ArtifactStore(join(root, 'objects'));
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Durable simulated fixture',
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Trusted fixture check passes'],
  });
  const artifact = store.recordArtifact(
    'task',
    artifacts,
    Buffer.from('[SIMULATED] Durable diagnostic fixture'),
  );
  store.queue('queue', 'task', 0);
  controller = new DurableController(store, {
    test: {
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
    },
  });
  await controller.run('dispatch', {
    taskId: 'task',
    workerId: 'worker',
    attemptId: 'attempt',
    workspaceId: 'workspace',
    sessionId: 'session',
    scenario: 'success',
    expectedVersion: 1,
  });
  controller.stop();
  store.close();
  store = new Store(join(root, 'state.sqlite'), { owner: 'restarted' });
  const task = store.accept('accept', 'task', store.getTask('task').rowVersion);
  await backupSnapshot(store, artifacts, join(root, 'backup'));
  await restoreSnapshot(join(root, 'backup'), join(root, 'restored'));
  const restored = new Database(join(root, 'restored', 'state.sqlite'), {
    readonly: true,
  });
  const restoreIntegrity = restored.pragma('integrity_check', { simple: true });
  restored.close();
  console.log(
    JSON.stringify({
      simulated: true,
      task,
      restartVerified: task.state === 'accepted',
      integrity: store.integrity(),
      restoreIntegrity,
      artifactVerified: new ArtifactStore(join(root, 'restored', 'artifacts'))
        .get(artifact)
        .toString()
        .startsWith('[SIMULATED]'),
      capabilities: executionCapabilities(),
    }),
  );
} finally {
  controller?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true });
}
