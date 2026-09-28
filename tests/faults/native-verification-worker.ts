import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../packages/storage/src/artifacts.ts';
import { NativeVerifier } from '../../apps/controller/src/native-verifier.ts';
const [root, point] = process.argv.slice(2);
const workspace = join(root!, 'work');
mkdirSync(workspace);
writeFileSync(join(workspace, 'result.txt'), 'attested bytes');
const store = new Store(join(root!, 'state.sqlite'), {
  owner: 'fixture',
  now: () => 1000,
  leaseMs: 500,
  fault: (stage) => {
    if (stage === point) process.exit(71);
  },
});
store.create('create', {
  id: 'task',
  projectId: 'project',
  objective: 'Native verification fixture',
  requiredCheckIds: ['check'],
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
store.providers.finish('connection', connection.token, 'turn:1', 'completed');
const objects = new ArtifactStore(join(root!, 'objects'));
const verifier = new NativeVerifier(
  store,
  objects,
  { workspace },
  {
    check: {
      executable: process.execPath,
      args: [
        '-e',
        "if(require('node:fs').readFileSync('result.txt','utf8') !== 'attested bytes') process.exit(1)",
      ],
    },
  },
);
const result = await verifier.verify('connection', connection.token, {
  stopped: true,
});
if (point === 'after_verified') process.exit(71);
verifier.stop();
store.close();
console.log(
  JSON.stringify({ classification: 'offline', status: result.status }),
);
process.exitCode = result.status === 'passed' ? 0 : 1;
