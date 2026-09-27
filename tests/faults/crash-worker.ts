import { Store } from '../../packages/storage/src/store.ts';
const [path, point] = process.argv.slice(2);
const store = new Store(path!, {
  owner: 'crashing',
  now: () => 1000,
  leaseMs: 500,
  fault: (stage) => {
    if (stage === point) process.exit(71);
  },
});
store.create('create', {
  id: 'task',
  projectId: 'project',
  objective: 'Crash fixture',
  requiredCheckIds: ['test'],
  acceptanceCriteria: ['Pass'],
});
store.queue('queue', 'task', 0);
const op = store.dispatch('dispatch', {
  taskId: 'task',
  workerId: 'worker',
  attemptId: 'attempt',
  workspaceId: 'workspace',
  sessionId: 'session',
  scenario: 'success',
  expectedVersion: 1,
});
if (point === 'after_dispatch') process.exit(71);
store.markSending('attempt', op.token);
if (point === 'after_send') process.exit(71);
const base = {
  schemaVersion: 1,
  taskId: 'task',
  attemptId: 'attempt',
  workerId: 'worker',
  runtimeKind: 'simulated',
  simulated: true,
};
store.receive('attempt', op.token, { ...base, sequence: 1, kind: 'started' });
if (point === 'after_ack') process.exit(71);
store.receive('attempt', op.token, {
  ...base,
  sequence: 2,
  kind: 'completed',
  treeHash: 'a'.repeat(64),
  artifactSetHash: 'b'.repeat(64),
});
if (point === 'after_result') process.exit(71);
throw new Error('Unrecognized crash point');
