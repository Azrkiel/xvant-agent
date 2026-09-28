import { fileURLToPath } from 'node:url';
import { NativeStream } from '../packages/adapters/src/providers/native-stream.ts';
import { versions } from '../packages/adapters/src/providers/native-profiles.ts';
import { WorkerSupervisor } from '../packages/supervisor/src/index.ts';
const [kind, scenario] = process.argv.slice(2);
if (
  !['claude', 'opencode'].includes(kind) ||
  ![
    'success',
    'permission',
    'wrong-session',
    'malformed',
    'partial',
    'error',
    'timeout',
    'cancel',
  ].includes(scenario)
)
  process.exit(2);
const stream = new NativeStream(kind, versions[kind], 'session-1', 'request-1');
const supervisor = new WorkerSupervisor();
let run,
  writes = Promise.resolve(),
  failed = false,
  denials = 0,
  outcome = 'unknown';
const fail = () => {
  failed = true;
  stream.cancel();
  if (run) supervisor.cancel(run.identity);
};
run = supervisor.start({
  executable: process.execPath,
  args: [
    fileURLToPath(
      new URL('../tests/fixtures/native-peer.mjs', import.meta.url),
    ),
    kind,
    scenario,
  ],
  cwd: process.cwd(),
  workerId: 'fixture',
  attemptId: 'attempt',
  generation: 1,
  timeoutMs: 1500,
  maxOutputBytes: 1048576,
  userApprovedTrustedLocal: true,
  interactive: {
    onStdout: (bytes) => {
      try {
        for (const action of stream.receive(bytes)) {
          writes = writes.then(async () => {
            await run.write(JSON.stringify(action.wire) + '\n');
            stream.denialWritten(action.requestId);
            denials++;
          });
          void writes.catch(fail);
        }
        if (stream.status === 'result_pending')
          void writes.then(() => run.endInput()).catch(fail);
      } catch {
        fail();
      }
    },
  },
});
try {
  await run.write('{"fixture":"start"}\n');
  if (scenario === 'cancel') fail();
  const stopped = await run.result;
  await writes;
  if (
    !failed &&
    stopped.reason === 'exited' &&
    stopped.exitCode === 0 &&
    !stopped.outputTruncated
  )
    outcome = stream.end().kind;
} catch {
  fail();
} finally {
  supervisor.stopAll();
  await run.result;
}
console.log(
  JSON.stringify({
    classification: 'offline',
    liveProvidersTested: [],
    kind,
    outcome,
    denials,
    activeCount: supervisor.activeCount,
  }),
);
const expected = ['success', 'permission'].includes(scenario)
  ? 'completed'
  : kind === 'claude' && scenario === 'error'
    ? 'failed'
    : 'unknown';
process.exitCode = outcome === expected && supervisor.activeCount === 0 ? 0 : 1;
