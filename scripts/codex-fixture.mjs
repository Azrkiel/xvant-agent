import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { durableCodexChannel } from '../packages/adapters/src/codex/durable.ts';
import { Store } from '../packages/storage/src/store.ts';
import { CodexLifecycle } from '../packages/adapters/src/codex/lifecycle.ts';
import {
  CODEX_VERSION,
  validateNative,
} from '../packages/adapters/src/codex/profile.ts';

const scenario = process.argv[2] ?? 'success';
if (
  ![
    'success',
    'approval',
    'interrupt',
    'disconnect',
    'malformed',
    'timeout',
  ].includes(scenario)
) {
  console.error('Unknown offline fixture scenario');
  process.exit(2);
}
const directory = mkdtempSync(join(tmpdir(), 'xvant-codex-fixture-'));
const journalPath = join(directory, 'state.sqlite');
const store = new Store(journalPath, { owner: 'fixture' });
store.create('create', {
  id: 'task',
  projectId: 'fixture',
  objective: 'Offline fixture',
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
    endpointId: 'fixture',
    nativeSessionId: 'thread-1',
    runtimeVersion: CODEX_VERSION,
    adapterVersion: 'v1',
    mode: 'managed',
    quotaGroupId: 'fixture',
  },
});
let durableState, taskState, persistedInbound;
let nativeRunId;
const life = new CodexLifecycle(CODEX_VERSION, 'thread-1');
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('../tests/fixtures/codex-peer.mjs', import.meta.url)),
    scenario,
  ],
  { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
);
let disposing = false,
  outcome = 'unknown',
  denials = 0,
  turnRequests = 0;
let resolveTerminal, rejectTerminal;
const terminal = new Promise((resolve, reject) => {
  resolveTerminal = resolve;
  rejectTerminal = reject;
});
void terminal.catch(() => {});
const stopped = new Promise((resolve) => {
  child.once('exit', resolve);
  child.once('error', resolve);
});
const fail = () => {
  life.disconnected();
  rejectTerminal(new Error('OPERATION_UNKNOWN'));
};
const channel = durableCodexChannel(store, connection, {
  timeoutMs: 1500,
  write: (frame) =>
    new Promise((resolve, reject) => {
      // Assert the persistence hook completed before these exact bytes reached the pipe.
      const intents = store.providers.entries(connection.connectionId);
      if (!intents.some((intent) => intent.frame === frame)) {
        reject(new Error('STORAGE_UNAVAILABLE'));
        return;
      }
      if (JSON.parse(frame).method === 'turn/start') turnRequests++;
      child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
    }),
  onMessage: (message) => {
    const action = life.message(message);
    if (action.kind === 'started') {
      nativeRunId = action.nativeRunId;
      store.providers.bindRun(
        connection.connectionId,
        connection.token,
        nativeRunId,
      );
    } else if (action.kind === 'deny') {
      denials++;
      void channel.respond(action.id, action.result).catch(fail);
    } else if (['completed', 'cancelled', 'failed'].includes(action.kind)) {
      outcome = action.kind;
      store.providers.finish(
        connection.connectionId,
        connection.token,
        nativeRunId,
        action.kind,
      );
      resolveTerminal();
    }
  },
});
child.stdout.on('data', (bytes) => {
  try {
    channel.receive(bytes);
  } catch {
    fail();
  }
});
child.stdin.on('error', () => {
  if (!disposing) fail();
});
child.on('error', fail);
child.on('exit', () => {
  if (!disposing) {
    try {
      channel.close();
    } catch {
      /* Pending work is already unknown. */
    }
    fail();
  }
});
const deadline = setTimeout(() => {
  try {
    channel.close();
  } catch {
    /* Partial EOF. */
  }
  fail();
}, 4000);
try {
  const init = life.initialize();
  const notification = life.initialized(
    await channel.request(init.method, init.params),
  );
  await channel.notify(notification.method, notification.params);
  const start = life.start('Read the synthetic fixture; no tool execution.');
  life.started(await channel.request(start.method, start.params));
  if (scenario === 'interrupt') {
    const interrupt = life.interrupt();
    validateNative(
      'TurnInterruptResponse',
      await channel.request(interrupt.method, interrupt.params),
    );
  }
  await terminal;
} catch {
  fail();
  outcome = 'unknown';
} finally {
  clearTimeout(deadline);
  disposing = true;
  try {
    channel.close();
  } catch {
    /* Failures were classified above. */
  }
  child.kill();
  await stopped;
  durableState = store.providers.get(connection.connectionId).status;
  taskState = store.getTask('task').state;
  persistedInbound = store.providers
    .entries(connection.connectionId)
    .filter((entry) => entry.direction === 'in').length;
  store.close();
  for (const path of [journalPath, journalPath + '-wal', journalPath + '-shm'])
    if (existsSync(path)) unlinkSync(path);
  rmdirSync(directory);
}
const report = {
  classification: 'offline',
  liveProvidersTested: [],
  state: life.status,
  outcome,
  denials,
  turnRequests,
  persistedBeforeWrite: true,
  durableState,
  taskState,
  persistedInbound,
};
console.log(JSON.stringify(report));
const expected = ['disconnect', 'malformed', 'timeout'].includes(scenario)
  ? 'needs_attention'
  : 'result_pending';
process.exitCode = life.status === expected && turnRequests === 1 ? 0 : 1;
