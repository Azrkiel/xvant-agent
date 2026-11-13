// Run after the gate, even on failure. No GitHub API or credentials are used.
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { sourceHash, verifyBundle } from './evidence-bundle.ts';
import { validateCiReceipt } from './ci-policy.ts';

const root = resolve(import.meta.dirname, '..');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const revision = git('rev-parse', 'HEAD');
const expected = process.env.XVANT_EXPECTED_REVISION ?? revision;
const summary = {
  sourceRevision: revision,
  expectedRevision: expected,
  status: 'failed',
  problems: [],
};
try {
  if (expected !== revision)
    throw new Error('Checkout differs from the event source revision');
  const changed = [
    git('diff', '--name-only', 'HEAD', '-z'),
    git('ls-files', '--others', '--exclude-standard', '-z'),
  ]
    .flatMap((list) => list.split('\0'))
    .filter((path) => path && !path.startsWith('docs/evidence/'));
  if (changed.length)
    throw new Error('Source checkout is dirty: ' + changed.join(', '));
  const receiptPath = resolve(root, 'docs/evidence/G10.json');
  const bytes = readFileSync(receiptPath);
  const receipt = validateCiReceipt(
    JSON.parse(bytes),
    revision,
    sourceHash(root),
  );
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runs = resolve(root, 'docs/evidence/runs');
  const matching = readdirSync(runs).filter((name) => {
    const path = resolve(runs, name, 'bundle.json');
    return (
      existsSync(path) &&
      JSON.parse(readFileSync(path)).receipt.sha256 === digest
    );
  });
  if (matching.length !== 1)
    throw new Error('Current receipt needs exactly one immutable bundle');
  const { bundle, problems } = verifyBundle(resolve(runs, matching[0]));
  if (problems.length || bundle.integrity !== 'complete')
    throw new Error(
      'Evidence bundle incomplete or altered: ' + problems.join('; '),
    );
  Object.assign(summary, {
    status: 'passed',
    sourceHash: receipt.dirtyTreeHash,
    bundleId: bundle.bundleId,
    checks: receipt.checks.length,
    tests: receipt.checks.find((check) => check.id === 'tests').observedCount,
  });
} catch (error) {
  summary.problems.push(error.message);
  process.exitCode = 1;
}
writeFileSync(
  resolve(root, '.artifacts/ci-summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `Offline gate: **${summary.status}**\n\nSource: \`${revision}\`\n\n` +
      `Platform: ${process.platform} ${process.arch}; Node ${process.version}\n\n` +
      (summary.status === 'passed'
        ? `${summary.checks} checks, ${summary.tests} tests. Bundle: \`${summary.bundleId}\`\n`
        : 'Inspect ci-summary.json, G10.json and retained check logs for the failure.\n'),
  );
