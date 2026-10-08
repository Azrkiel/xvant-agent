// Offline soak (P10.2). Usage: node scripts/soak.mjs --minutes N [--seed S]
// Runs orchestrated objectives against throwaway Git repositories for N
// minutes with a fake turn runner that injects faults (turn failure, unknown
// outcome, conflicting patches, failing check, rejecting review) from a
// seeded generator, and checks the invariants after every iteration. No model
// is called. Writes docs/evidence/P10-soak.json; it passes only with no
// invariant violation. The seed is printed so a failure can be replayed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { archiveRun, sourceHash } from './evidence-bundle.ts';
import { runSoak } from './soak-run.ts';

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const minutes = Number(value('--minutes'));
if (!args.includes('--minutes') || !(minutes > 0)) {
  console.error('Usage: node scripts/soak.mjs --minutes N [--seed S]');
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
const gateId = 'P10-soak';
const report = {
  gateId,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  classification: 'offline',
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  sourceHash: sourceHash(root),
  limitations: [
    'Offline simulator only: the orchestrator, store, worktrees and checks are real, but every turn is a scripted fake. There is no live soak and no model, runtime or quota behavior is exercised.',
    'Faults are the five classes the fake injects (turn failure, unknown outcome, conflicting patches, failing check, rejecting review); anything else is not covered.',
    'One process and one orchestrator at a time; concurrent roots, a crash mid-run and a restart with resume are covered by other tests, not by this run.',
    'Memory is process rss of this run only, sampled once per iteration; the short git and check child processes are not included, and rss growth below the stated floor is not flagged.',
    'The invariant checks look at the run, its branches and worktrees, and the temp directory; they cannot see a process that leaked outside this one.',
  ],
  problems: [],
};
const run = await runSoak({
  seed,
  minutes,
  log: (line) => console.log(line),
});
Object.assign(report, run);
report.problems.push(...run.violations);
if (run.iterations === 0) report.problems.push('No iteration ran');
// A long run in which a fault class never occurred did not test it.
if (run.iterations >= 30)
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
