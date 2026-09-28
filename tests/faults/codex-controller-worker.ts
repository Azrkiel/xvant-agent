import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../packages/storage/src/artifacts.ts';
import { OfflineCodexController } from '../../apps/controller/src/codex-offline.ts';
import { CODEX_VERSION } from '../../packages/adapters/src/codex/profile.ts';

const [root, point] = process.argv.slice(2);
const workspace = join(root!, 'work');
mkdirSync(workspace);
writeFileSync(join(workspace, 'result.txt'), 'offline fixture');
const fault = (stage: string) => {
  if (stage === point) process.exit(71);
};
const store = new Store(join(root!, 'state.sqlite'), {
  owner: 'fixture',
  now: () => 1000,
  leaseMs: 500,
  fault,
});
store.create('create', {
  id: 'task',
  projectId: 'project',
  objective: 'Read fixture',
  requiredCheckIds: ['check'],
  acceptanceCriteria: ['Pass'],
});
store.queue('queue', 'task', 0);
const controller = new OfflineCodexController(
  store,
  new ArtifactStore(join(root!, 'objects')),
  { workspace },
  { check: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } },
  { fault },
);
await controller.run({
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
    endpointId: 'fixture',
    nativeSessionId: 'thread-1',
    runtimeVersion: CODEX_VERSION,
    adapterVersion: 'v1',
    mode: 'managed',
    quotaGroupId: 'account',
  },
});
controller.stop();
store.close();
process.exitCode = 72;
