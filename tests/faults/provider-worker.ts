import { Store } from '../../packages/storage/src/store.ts';
import { durableCodexChannel } from '../../packages/adapters/src/codex/durable.ts';
const [path, point] = process.argv.slice(2);
const crash = (stage: string) => {
  if (stage === point) process.exit(71);
};
const store = new Store(path!, {
  owner: 'crashing',
  now: () => 1000,
  leaseMs: 500,
  fault: crash,
});
store.create('create', {
  id: 'task',
  projectId: 'project',
  objective: 'Crash fixture',
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
    nativeSessionId: 'thread-1',
    runtimeVersion: '0.158.0-alpha.2.1',
    adapterVersion: 'v1',
    mode: 'managed',
    quotaGroupId: 'account',
  },
});
const channel = durableCodexChannel(store, connection, {
  write: (frame) =>
    new Promise<void>((resolve, reject) => {
      if (JSON.parse(frame).method === 'turn/start') crash('before_write');
      process.stdout.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        if (JSON.parse(frame).method === 'turn/start') crash('after_write');
        resolve();
      });
    }),
  onMessage: (message) => {
    if (message.method !== 'turn/completed') throw new Error('INVALID_EVENT');
    store.providers.finish(
      connection.connectionId,
      connection.token,
      'turn-1',
      'completed',
    );
    crash('after_result');
  },
});
process.stdin.on('data', (bytes) => channel.receive(bytes));
await channel.request('turn/start', { threadId: 'thread-1' });
crash('after_ack');
store.providers.bindRun(connection.connectionId, connection.token, 'turn-1');
await channel.notify('fixture/ready', {});
