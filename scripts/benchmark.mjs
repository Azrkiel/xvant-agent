// Benchmark campaigns over a frozen suite.
// Usage: node scripts/benchmark.mjs --suite smoke --freeze
//        node scripts/benchmark.mjs --suite smoke --repeats 3 --report docs/evidence/benchmark-smoke.json [--configurations reference,noop]
// Only the offline `reference` and `noop` configurations exist so far; they
// check the harness, not any model or runtime.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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
const names = (value('--configurations') ?? 'reference,noop').split(',');
const unknown = names.filter((name) => !available[name]);
if (unknown.length) {
  console.error('Unknown configuration: ' + unknown.join(', '));
  process.exit(2);
}
mkdirSync('.artifacts', { recursive: true });
const state = join(
  realpathSync(resolve('.artifacts')),
  'benchmark-' + suiteId + '-' + Date.now(),
);
mkdirSync(state, { recursive: true });
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
const summary = summarize(suite, lock.frozenHash, schedule, records);
const shape = suiteId === 'v1' ? v1ShapeProblems(suite) : [];
const report = {
  generatedAt: new Date().toISOString(),
  classification: 'offline',
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
