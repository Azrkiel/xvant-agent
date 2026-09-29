import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../packages/storage/src/artifacts.ts';
import { OfflineOpenCodeHttpController } from '../../apps/controller/src/opencode-http.ts';
import { versions } from '../../packages/adapters/src/providers/native-profiles.ts';

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
const controller = new OfflineOpenCodeHttpController(
  store,
  new ArtifactStore(join(root!, 'objects')),
  { workspace },
  { check: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } },
  { fault },
);
const interrupting = point === 'opencode.after_interrupt_request';
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
  interrupting ? 'interrupt' : 'permission',
);
while (interrupting) {
  try {
    controller.interrupt('connection', 'operator');
    break;
  } catch (error) {
    if ((error as Error).message !== 'NOT_INTERRUPTIBLE') throw error;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
await pending;
controller.stop();
store.close();
process.exitCode = 72;
