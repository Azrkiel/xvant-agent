// Soak (P10.2). Usage:
//   node scripts/soak.mjs --minutes N [--seed S]
//   node scripts/soak.mjs --live --approve-live --minutes N [--max-iterations K] [--seed S]
// Runs orchestrated objectives against throwaway Git repositories for N
// minutes with a fake turn runner that injects faults (turn failure, unknown
// outcome, conflicting patches, failing check, rejecting review) from a
// seeded generator, and checks the invariants after every iteration. No model
// is called. Writes docs/evidence/P10-soak.json; it passes only with no
// invariant violation. The seed is printed so a failure can be replayed.
// With --live the turns are real Claude Code turns on Haiku (this uses the
// Claude subscription); faults come from the environment, and the receipt is
// docs/evidence/P10-soak-live.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { archiveRun, sourceHash } from './evidence-bundle.ts';
import { runSoak } from './soak-run.ts';
import {
  LIVE_LIMITATIONS,
  createLiveDriver,
  liveReceipt,
} from './soak-live.ts';

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const minutes = Number(value('--minutes'));
const live = args.includes('--live');
const maxIterations = args.includes('--max-iterations')
  ? Number(value('--max-iterations'))
  : undefined;
if (
  !args.includes('--minutes') ||
  !(minutes > 0) ||
  (maxIterations !== undefined &&
    !(Number.isSafeInteger(maxIterations) && maxIterations > 0))
) {
  console.error(
    'Usage: node scripts/soak.mjs [--live --approve-live] --minutes N [--max-iterations K] [--seed S]',
  );
  process.exit(2);
}
if (live && !args.includes('--approve-live')) {
  console.error(
    'A live soak runs real Claude Code turns on the subscription login. Add --approve-live to run it.',
  );
  process.exit(2);
}
const seed = args.includes('--seed')
  ? Number(value('--seed'))
  : Math.floor(Date.now() % 2147483647);
if (!Number.isSafeInteger(seed)) {
  console.error('--seed must be an integer');
  process.exit(2);
}
const root = resolve('.');
const gateId = live ? 'P10-soak-live' : 'P10-soak';
const report = {
  gateId,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  classification: live ? 'live' : 'offline',
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  sourceHash: sourceHash(root),
  limitations: live
    ? LIVE_LIMITATIONS
    : [
        'Offline simulator only: the orchestrator, store, worktrees and checks are real, but every turn is a scripted fake. There is no live soak and no model, runtime or quota behavior is exercised.',
        'Faults are the five classes the fake injects (turn failure, unknown outcome, conflicting patches, failing check, rejecting review); anything else is not covered.',
        'One process and one orchestrator at a time; concurrent roots, a crash mid-run and a restart with resume are covered by other tests, not by this run.',
        'Memory is process rss of this run only, sampled once per iteration; the short git and check child processes are not included, and rss growth below the stated floor is not flagged.',
        'The invariant checks look at the run, its branches and worktrees, and the temp directory; they cannot see a process that leaked outside this one.',
      ],
  problems: [],
};
let driver;
if (live) {
  try {
    driver = await createLiveDriver();
  } catch (error) {
    console.error('Live soak refused: ' + error.message);
    process.exit(1);
  }
  console.log(
    'live soak: claude ' +
      (driver.runtime.version ?? '?') +
      ' on ' +
      driver.model,
  );
}
const run = await runSoak({
  seed,
  minutes,
  ...(maxIterations ? { maxIterations } : {}),
  ...(driver ? { driver } : {}),
  log: (line) => console.log(line),
});
Object.assign(report, run);
if (live) {
  const { problems, ...fields } = liveReceipt(run, {
    minutes,
    maxIterations: maxIterations ?? null,
    model: driver.model,
    runtime: driver.runtime,
  });
  Object.assign(report, fields);
  report.problems.push(...problems);
} else {
  report.problems.push(...run.violations);
  if (run.iterations === 0) report.problems.push('No iteration ran');
}
// A long run in which a fault class never occurred did not test it.
if (!live && run.iterations >= 30)
  for (const [fault, count] of Object.entries(run.faultCounts))
    if (!count) report.problems.push('fault never occurred: ' + fault);
if (sourceHash(root) !== report.sourceHash)
  report.problems.push('Source changed during the run');
report.status = report.problems.length === 0 ? 'passed' : 'failed';
mkdirSync('docs/evidence', { recursive: true });
const receiptFile = resolve(root, 'docs/evidence/' + gateId + '.json');
writeFileSync(receiptFile, JSON.stringify(report, null, 2) + '\n');
console.log(
  gateId +
    ': ' +
    report.status +
    ' (' +
    run.iterations +
    ' iterations, seed ' +
    seed +
    ')',
);
if (report.problems.length) console.log(report.problems.join('\n'));
process.exitCode = report.status === 'passed' ? 0 : 1;
try {
  const bundle = archiveRun({
    receiptFile,
    sourceRoot: root,
    destination: resolve(root, 'docs/evidence/runs'),
  });
  console.log('evidence bundle: ' + bundle.bundleId + ' ' + bundle.integrity);
} catch (error) {
  console.error('Evidence archival failed: ' + error.message);
  process.exitCode = 1;
}
