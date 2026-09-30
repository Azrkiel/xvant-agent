import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from '../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../packages/storage/src/artifacts.ts';
import { LiveOpenCodeController } from '../../apps/controller/src/opencode-live.ts';

const [root, point] = process.argv.slice(2);
if (!root || !point) throw new Error('INVALID_INPUT');
const workspace = join(root, 'work');
mkdirSync(workspace);
const fault = (stage: string) => {
  if (stage === point) process.exit(71);
};
const store = new Store(join(root, 'state.sqlite'), {
  owner: 'live_fixture',
  now: () => 1000,
  leaseMs: 500,
  fault,
});
store.create('create', {
  id: 'task',
  projectId: 'project',
  objective: 'Return XVANT_LIVE_OK',
  requiredCheckIds: ['check'],
  acceptanceCriteria: ['Pass'],
});
store.queue('queue', 'task', 0);
const controller = new LiveOpenCodeController(
  store,
  new ArtifactStore(join(root, 'objects')),
  { workspace },
  {
    check: {
      executable: process.execPath,
      args: [
        '-e',
        "if(require('node:fs').readFileSync('.xvant-result-attempt.txt','utf8') !== 'XVANT_LIVE_OK')process.exit(1)",
      ],
    },
  },
  {
    executable: process.execPath,
    prefixArgs: [resolve('tests/fixtures/opencode-cli.mjs'), 'success'],
    fault,
  },
);
await controller.run({
  connectionId: 'connection',
  taskId: 'task',
  attemptId: 'attempt',
  workspaceId: 'workspace',
  expectedVersion: 1,
  classification: 'live',
  liveApproval: {
    actorId: 'operator',
    model: 'opencode/big-pickle',
    transport: 'cli',
    userApprovedTrustedLocal: true,
  },
  worker: {
    id: 'worker',
    alias: 'worker',
    runtimeKind: 'opencode',
    hostId: 'host',
    endpointId: 'cli_fixture',
    nativeSessionId: 'ses_Provisional',
    runtimeVersion: '2.0.19',
    adapterVersion: 'opencode-cli-v2',
    mode: 'managed',
    quotaGroupId: 'account',
  },
});
controller.stop();
store.close();
process.exitCode = 72;
