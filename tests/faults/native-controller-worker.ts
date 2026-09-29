import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../packages/storage/src/artifacts.ts';
import { OfflineNativeController } from '../../apps/controller/src/native-offline.ts';
import { versions } from '../../packages/adapters/src/providers/native-profiles.ts';

const [root, point, kind, modeInput = 'resume', scenario] =
  process.argv.slice(2);
if (modeInput !== 'resume' && modeInput !== 'create')
  throw new Error('INVALID_INPUT');
if (kind !== 'claude' && kind !== 'opencode') throw new Error('INVALID_INPUT');
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
const controller = new OfflineNativeController(
  store,
  new ArtifactStore(join(root!, 'objects')),
  { workspace },
  { check: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } },
  { fault },
);
const interrupting = [
  'provider.interrupt.before_commit',
  'native.after_interrupt_request',
  'native.after_interrupt',
].includes(point!);
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
      runtimeKind: kind,
      hostId: 'host',
      endpointId: 'fixture',
      nativeSessionId:
        kind === 'claude' && modeInput === 'create'
          ? '6306ed11-5ca4-4c61-a177-5b64eddf5d5b'
          : 'session-1',
      runtimeVersion: versions[kind],
      adapterVersion: 'v1',
      mode: 'managed',
      quotaGroupId: 'account',
    },
  },
  scenario ?? (interrupting ? 'interrupt' : 'permission'),
  modeInput,
);
// Poll like a host operator until the running turn admits the interrupt.
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
