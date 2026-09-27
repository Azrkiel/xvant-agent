import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  rmdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RpcChannel } from '../packages/adapters/src/codex/transport.ts';
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
const journalPath = join(directory, 'intents.jsonl');
const journal = openSync(journalPath, 'a');
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
const channel = new RpcChannel({
  timeoutMs: 1500,
  beforeWrite: async (intent) => {
    writeSync(journal, JSON.stringify(intent) + '\n');
    fsyncSync(journal);
  },
  write: (frame) =>
    new Promise((resolve, reject) => {
      // Assert the persistence hook completed before these exact bytes reached the pipe.
      const intents = readFileSync(journalPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      if (!intents.some((intent) => intent.frame === frame)) {
        reject(new Error('STORAGE_UNAVAILABLE'));
        return;
      }
      if (JSON.parse(frame).method === 'turn/start') turnRequests++;
      child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
    }),
  onMessage: (message) => {
    const action = life.message(message);
    if (action.kind === 'deny') {
      denials++;
      void channel.respond(action.id, action.result).catch(fail);
    } else if (['completed', 'cancelled', 'failed'].includes(action.kind)) {
      outcome = action.kind;
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
  closeSync(journal);
  unlinkSync(journalPath);
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
};
console.log(JSON.stringify(report));
const expected = ['disconnect', 'malformed', 'timeout'].includes(scenario)
  ? 'needs_attention'
  : 'result_pending';
process.exitCode = life.status === expected && turnRequests === 1 ? 0 : 1;
