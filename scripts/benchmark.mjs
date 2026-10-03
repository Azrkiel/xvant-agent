// Benchmark campaigns over a frozen suite.
// Usage: node scripts/benchmark.mjs --suite smoke --freeze
//        node scripts/benchmark.mjs --suite smoke --repeats 3 --report docs/evidence/benchmark-smoke.json [--configurations reference,noop]
//        node scripts/benchmark.mjs --suite smoke --repeats 1 --report <file> --configurations claude-haiku --approve-live [--resume <state dir>]
// `reference` and `noop` are offline and only check the harness. `claude-haiku`
// and `claude-sonnet` run real turns on the Claude subscription login and need
// --approve-live; nothing here can fall back to an API key.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  computeLock,
  suitePath,
  v1ShapeProblems,
  verifyFrozen,
} from '../packages/evaluation/src/suite.ts';
import { runBenchmark } from '../packages/evaluation/src/runner.ts';
import { summarize } from '../packages/evaluation/src/report.ts';
import {
  noopConfiguration,
  referenceConfiguration,
} from '../packages/evaluation/src/reference.ts';
import { discoverRuntime } from '../packages/adapters/src/live/discover.ts';
import {
  liveConfiguration,
  nativeConfiguration,
  orchestratedConfiguration,
} from '../apps/controller/src/benchmark-live.ts';
import { LocalEndpointProvider } from '../packages/native-agent/src/local-endpoint.ts';

const args = process.argv.slice(2);
const value = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const suiteId = value('--suite');
if (!suiteId || !/^[a-z0-9-]+$/.test(suiteId)) {
  console.error(
    'Usage: node scripts/benchmark.mjs --suite <id> (--freeze | --repeats N --report <file> [--configurations a,b])',
  );
  process.exit(2);
}
const suiteDir = resolve('fixtures/benchmarks', suiteId);
if (args.includes('--freeze')) {
  const lock = computeLock(suiteDir);
  writeFileSync(
    join(suiteDir, 'suite.lock.json'),
    JSON.stringify(lock, null, 2) + '\n',
  );
  console.log('frozen ' + suiteId + ' ' + lock.frozenHash);
  process.exit(0);
}
const repeats = Number(value('--repeats') ?? 3);
const reportPath = value('--report');
if (
  !Number.isSafeInteger(repeats) ||
  repeats < 1 ||
  repeats > 10 ||
  !reportPath
) {
  console.error('--repeats must be 1-10 and --report is required');
  process.exit(2);
}
const { suite, lock } = verifyFrozen(suiteDir);
const available = {
  reference: referenceConfiguration((taskId) =>
    join(
      dirname(
        suitePath(suiteDir, suite.tasks.find((t) => t.id === taskId).check),
      ),
      'solution.json',
    ),
  ),
  noop: noopConfiguration,
};
// `native-local` is XVANT's own loop on a loopback model: --model <id> [--endpoint <url>].
// A `-skills` suffix puts the task's XVANT skill (SKILL.md) before the objective.
const skillFor = (taskId) => {
  const task = suite.tasks.find((t) => t.id === taskId);
  const fixture = join(
    dirname(suitePath(suiteDir, task.check)),
    'fixture.json',
  );
  const { skill } = JSON.parse(readFileSync(fixture, 'utf8'));
  return readFileSync(resolve('skills', skill, 'SKILL.md'), 'utf8');
};
// A `-criteria` suffix states the task's acceptance criteria, as XVANT does for its workers.
const criteriaList = (taskId) => {
  const task = suite.tasks.find((t) => t.id === taskId);
  const fixture = join(
    dirname(suitePath(suiteDir, task.check)),
    'fixture.json',
  );
  return JSON.parse(readFileSync(fixture, 'utf8')).acceptanceCriteria;
};
const criteriaFor = (taskId) => {
  const task = suite.tasks.find((t) => t.id === taskId);
  const fixture = join(
    dirname(suitePath(suiteDir, task.check)),
    'fixture.json',
  );
  const { acceptanceCriteria } = JSON.parse(readFileSync(fixture, 'utf8'));
  return [
    'The result is accepted only if all of these hold:',
    ...acceptanceCriteria.map((c) => '- ' + c),
  ].join('\n');
};
// A `-xvant` suffix runs XVANT's orchestration (plan, work, repair, review) on that runtime.
const bare = (name) => name.replace(/-(skills|criteria|xvant)$/, '');
const LIVE = {
  'claude-haiku': 'haiku',
  'claude-sonnet': 'sonnet',
  // The runner pins OpenCode to its free model whatever is named here.
  'opencode-free': 'opencode/big-pickle',
  'native-local': value('--model'),
};
const names = (value('--configurations') ?? 'reference,noop').split(',');
const unknown = names.filter(
  (name) => !available[name] && !Object.hasOwn(LIVE, bare(name)),
);
if (unknown.length) {
  console.error('Unknown configuration: ' + unknown.join(', '));
  process.exit(2);
}
const live = names.filter((name) => Object.hasOwn(LIVE, bare(name)));
const extra = (name) =>
  name.endsWith('-skills')
    ? { instructions: skillFor, instructionsKind: 'skill' }
    : name.endsWith('-criteria')
      ? { instructions: criteriaFor, instructionsKind: 'criteria' }
      : {};
if (live.length && !args.includes('--approve-live')) {
  console.error(live.join(', ') + ' runs real model turns: add --approve-live');
  process.exit(2);
}
mkdirSync('.artifacts', { recursive: true });
// A campaign resumes from its state directory; recorded attempts never rerun.
const state = value('--resume')
  ? realpathSync(resolve(value('--resume')))
  : join(
      realpathSync(resolve('.artifacts')),
      'benchmark-' + suiteId + '-' + Date.now(),
    );
mkdirSync(state, { recursive: true });
const runtimes = {};
for (const name of live.filter((n) => bare(n) === 'native-local')) {
  if (!LIVE['native-local']) {
    console.error('native-local needs --model <id> (see `lms ls`)');
    process.exit(2);
  }
  const provider = new LocalEndpointProvider({
    baseUrl: value('--endpoint') ?? 'http://127.0.0.1:1234/v1',
    model: LIVE['native-local'],
    server: 'lmstudio',
  });
  runtimes['native-local'] ??= await provider.probe();
  if (!runtimes['native-local'].toolCalls) {
    console.error('The local model failed the tool-call probe');
    process.exit(1);
  }
  available[name] = nativeConfiguration({
    provider,
    ...extra(name),
    classification: 'live',
    stateRoot: join(state, 'controllers'),
  });
}
for (const name of live.filter((n) => bare(n) !== 'native-local')) {
  const kind = name.split('-')[0];
  const found = (runtimes[kind] ??= discoverRuntime(kind));
  if (found.status !== 'qualified') {
    console.error(kind + ' runtime not qualified: ' + found.status);
    process.exit(1);
  }
  const runtime = {
    executable: found.executable,
    version: found.version,
    model: LIVE[bare(name)],
  };
  const stateRoot = join(state, 'controllers');
  available[name] = name.endsWith('-xvant')
    ? orchestratedConfiguration({
        kind,
        runtime,
        stateRoot,
        criteria: criteriaList,
      })
    : liveConfiguration({ kind, runtime, ...extra(name), stateRoot });
}
// A live campaign asks Windows not to idle-sleep while it runs; a suspended
// host loses the attempts in flight. Closing the lid still suspends.
const awake =
  live.length && process.platform === 'win32'
    ? spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Add-Type -Namespace Xvant -Name Power -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);\'; [void][Xvant.Power]::SetThreadExecutionState(0x80000001); [void][Console]::In.ReadLine()',
        ],
        { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
      )
    : undefined;
process.on('exit', () => awake?.kill());
const { schedule, records } = await runBenchmark({
  suiteDir,
  configurations: Object.fromEntries(names.map((n) => [n, available[n]])),
  repeats,
  recordsPath: join(state, 'records.jsonl'),
  workRoot: join(state, 'work'),
  onRecord: (r) =>
    console.log(
      r.configuration.padEnd(10),
      r.taskId.padEnd(26),
      String(r.repeat).padEnd(2),
      r.status,
    ),
});
awake?.kill();
const summary = summarize(suite, lock.frozenHash, schedule, records);
const shape = suiteId === 'v1' ? v1ShapeProblems(suite) : [];
const report = {
  generatedAt: new Date().toISOString(),
  classification: live.length ? 'live' : 'offline',
  stateDirectory: state,
  runtimes,
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  repeats,
  ...summary,
  suiteShapeProblems: shape,
  records,
};
mkdirSync(dirname(resolve(reportPath)), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
for (const [name, c] of Object.entries(summary.configurations))
  console.log(
    name +
      ': ' +
      c.accepted +
      '/' +
      c.scheduled +
      ' accepted, ' +
      c.failed +
      ' failed, ' +
      c.incomplete +
      ' incomplete, ' +
      c.missing +
      ' missing',
  );
console.log(
  'complete: ' +
    summary.complete +
    (summary.directional ? ' (directional)' : ''),
);
process.exitCode = summary.complete && shape.length === 0 ? 0 : 1;
