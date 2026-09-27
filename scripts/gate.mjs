import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, platform, release } from 'node:os';
import { validateTestReport, phaseSuites } from './gate-policy.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (
  args.length !== 3 ||
  args[0] !== '--phase' ||
  !['01', '02'].includes(args[1]) ||
  args[2] !== '--offline'
) {
  console.error('Usage: npm run gate -- --phase 01|02 --offline');
  process.exit(2);
}
const phase = args[1];
const gateId = 'G' + phase;
const expectedSuites = phaseSuites(phase);
const artifacts = resolve(root, '.artifacts');
mkdirSync(artifacts, { recursive: true });
mkdirSync(resolve(root, 'docs/evidence'), { recursive: true });
const hash = (contents) => createHash('sha256').update(contents).digest('hex');
const git = (args) =>
  spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
function snapshot() {
  const listing = git([
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  if (listing.status !== 0) throw new Error('Cannot inventory source tree');
  const paths = [...new Set(listing.stdout.split('\0').filter(Boolean))]
    .filter((path) => !path.startsWith('docs/evidence/'))
    .sort();
  const files = paths.map((path) => ({
    path,
    sha256: existsSync(resolve(root, path))
      ? hash(readFileSync(resolve(root, path)))
      : 'deleted',
  }));
  return { sha256: hash(JSON.stringify(files)), files };
}
const report = {
  gateId,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  sourceRevision: git(['rev-parse', '--verify', 'HEAD']).stdout.trim() || null,
  branch: git(['branch', '--show-current']).stdout.trim(),
  dirtyTreeHash: null,
  sourceHashScope:
    'All Git-indexed and nonignored files except docs/evidence; includes uncommitted files.',
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  npmVersion: process.env.npm_config_user_agent ?? 'not invoked through npm',
  gitVersion: git(['--version']).stdout.trim(),
  classification: 'offline',
  runtimeKind: 'simulated',
  liveProvidersTested: [],
  checks: [],
  artifacts: [],
  limitations: [
    'This report qualifies only its recorded host and platform; other CI jobs need their own reports.',
    'Simulation fixtures do not qualify provider protocols, subscriptions, or real coding ability.',
    'Process supervision is trusted-local only. No hostile-code, filesystem, network, or escaped-descendant containment is qualified.',
    'Linux code and CI are configured but require their own observed run.',
  ],
  rollbackProcedure:
    'Keep the branch unmerged; no external service or data migration was changed.',
  lastKnownGoodVersion: null,
};
function check(id, args) {
  const startedAt = new Date().toISOString();
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const log = resolve(artifacts, id + '.log');
  writeFileSync(
    log,
    (child.stdout ?? '') +
      (child.stderr ?? '') +
      (child.error ? '\n' + child.error.message : ''),
  );
  const result = {
    id,
    command: [process.execPath, ...args],
    workingDirectory: root,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: child.status ?? 1,
  };
  report.checks.push(result);
  report.artifacts.push({
    path: relative(root, log).replaceAll('\\', '/'),
    sha256: hash(readFileSync(log)),
  });
  console.log(id + ': ' + (result.exitCode === 0 ? 'passed' : 'FAILED'));
  if (result.exitCode !== 0)
    console.error((child.stdout ?? '') + (child.stderr ?? ''));
  return result;
}
try {
  const before = snapshot();
  report.dirtyTreeHash = before.sha256;
  const pinned = readFileSync(resolve(root, '.node-version'), 'utf8').trim();
  if (process.version !== 'v' + pinned)
    throw new Error('Use pinned Node ' + pinned + '; found ' + process.version);
  check('typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']);
  check('lint', [
    'node_modules/eslint/bin/eslint.js',
    'packages',
    'apps',
    'scripts',
    'tests',
  ]);
  check('format', ['node_modules/prettier/bin/prettier.cjs', '--check', '.']);
  const tests = check('tests', [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--coverage',
    '--reporter=default',
    '--reporter=json',
    '--outputFile=.artifacts/tests.json',
  ]);
  if (tests.exitCode === 0) {
    const discovery = validateTestReport(
      JSON.parse(readFileSync(resolve(artifacts, 'tests.json'), 'utf8')),
      expectedSuites,
    );
    tests.expectedCount = Object.values(expectedSuites).reduce(
      (a, b) => a + b,
      0,
    );
    tests.observedCount = discovery.total;
    tests.suites = discovery.suites;
  }
  check(
    'runtime',
    phase === '01'
      ? ['apps/controller/src/demo.ts', 'success']
      : ['apps/controller/src/durable-demo.ts'],
  );
  const runtime = JSON.parse(
    readFileSync(resolve(artifacts, 'runtime.log'), 'utf8'),
  );
  if (
    runtime.simulated !== true ||
    (phase === '01'
      ? runtime.task.state !== 'ready_for_acceptance' ||
        runtime.attempt.state !== 'succeeded'
      : runtime.task.state !== 'accepted' ||
        runtime.restartVerified !== true ||
        runtime.integrity !== 'ok' ||
        runtime.restoreIntegrity !== 'ok' ||
        runtime.artifactVerified !== true)
  )
    throw new Error('Demo failed to reach verified simulated readiness');
  for (const path of [
    '.artifacts/tests.json',
    'coverage/coverage-summary.json',
  ]) {
    if (existsSync(resolve(root, path)))
      report.artifacts.push({
        path,
        sha256: hash(readFileSync(resolve(root, path))),
      });
  }
  const after = snapshot();
  if (after.sha256 !== before.sha256)
    throw new Error('Source changed during verification');
  writeFileSync(
    resolve(artifacts, 'source-manifest.json'),
    JSON.stringify(before, null, 2) + '\n',
  );
  report.artifacts.push({
    path: '.artifacts/source-manifest.json',
    sha256: hash(readFileSync(resolve(artifacts, 'source-manifest.json'))),
  });
  if (
    report.checks.every((check) => check.exitCode === 0) &&
    tests.observedCount
  )
    report.status = 'passed';
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'Gate failed';
  console.error(report.failure);
}
writeFileSync(
  resolve(root, 'docs/evidence/' + gateId + '.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(gateId + ': ' + report.status);
process.exitCode = report.status === 'passed' ? 0 : 1;
