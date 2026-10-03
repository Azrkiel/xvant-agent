// Release audit (P10.4): lockfile integrity, dependency licences, tracked
// secrets and local API exposure. Usage: npm run audit:release [-- --report <file>]
// Reads only this checkout; it contacts no registry and changes nothing else.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { sourceHash } from './evidence-bundle.ts';
import {
  licenseProblems,
  listenProblems,
  lockfileProblems,
  secretFindings,
} from './audit-policy.ts';

const args = process.argv.slice(2);
const reportPath = args.includes('--report')
  ? args[args.indexOf('--report') + 1]
  : undefined;
const root = resolve('.');
const listing = spawnSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (listing.status !== 0) throw new Error('Cannot list tracked files');
const tracked = listing.stdout.split('\0').filter(Boolean);
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const skippedLarge = [];
const files = tracked.map((path) => {
  try {
    if (statSync(resolve(root, path)).size > MAX_SCAN_BYTES) {
      skippedLarge.push(path);
      return { path, text: null };
    }
    return { path, text: readFileSync(resolve(root, path), 'utf8') };
  } catch {
    return { path, text: null };
  }
});
// Fake credentials live only in tests and fixtures that exercise the detector.
const expectedSecrets = (path) =>
  /\.test\.ts$/.test(path) ||
  path.startsWith('tests/') ||
  path.startsWith('fixtures/') ||
  path === 'packages/context/src/secrets.ts';
const lock = JSON.parse(
  readFileSync(resolve(root, 'package-lock.json'), 'utf8'),
);
const product = files.filter(
  ({ path, text }) =>
    text !== null &&
    /^(packages|apps)\/.*\.ts$/.test(path) &&
    !/\.test\.ts$|fixture/.test(path),
);
const checks = {
  lockfile: lockfileProblems(lock),
  licences: licenseProblems(lock),
  secrets: secretFindings(files, expectedSecrets),
  localApi: listenProblems(product),
};
const report = {
  kind: 'release-audit',
  generatedAt: new Date().toISOString(),
  status: Object.values(checks).every((p) => p.length === 0)
    ? 'passed'
    : 'failed',
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  sourceHash: sourceHash(root),
  trackedFiles: tracked.length,
  checks,
  limitations: [
    'Secret scanning matches known credential shapes and file names only.',
    'Licences are the ones recorded in package-lock.json; licence texts were not read.',
    'Files over 2 MiB are not scanned for secrets: ' +
      (skippedLarge.join(', ') || 'none'),
    'Executable hook boundaries are covered by tests, not by this audit.',
  ],
};
for (const [name, problems] of Object.entries(checks)) {
  console.log(name + ': ' + (problems.length ? 'FAILED' : 'passed'));
  for (const problem of problems.slice(0, 20)) console.log('  ' + problem);
  if (problems.length > 20)
    console.log('  ... and ' + (problems.length - 20) + ' more');
}
if (reportPath)
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.status === 'passed' ? 0 : 1;
