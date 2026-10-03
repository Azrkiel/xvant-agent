// Gate G00: record the environment and runtime compatibility matrix and the
// billing scope this checkout can reach. Usage: node scripts/g00.mjs
// It starts no model turn and reads no credential; it only checks versions
// and that no metered-API key is present in the environment.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { archiveRun, sourceHash } from './evidence-bundle.ts';
import { discoverRuntime } from '../packages/adapters/src/live/discover.ts';

const root = resolve('.');
// Any of these would let a runtime bill a metered API instead of a subscription.
const METERED_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
];
const version = (command, args) => {
  const run = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  return run.status === 0 ? run.stdout.trim() : null;
};
const pinned = readFileSync(resolve(root, '.node-version'), 'utf8').trim();
let sqlite = null;
try {
  const db = new Database(':memory:');
  sqlite = db.prepare('select sqlite_version() as v').get().v;
  db.close();
} catch {
  /* Recorded as a problem below. */
}
const runtimes = Object.fromEntries(
  ['codex', 'claude', 'opencode'].map((kind) => [kind, discoverRuntime(kind)]),
);
const meteredKeysPresent = METERED_KEYS.filter((key) => process.env[key]);
const problems = [];
if (process.version !== 'v' + pinned)
  problems.push('Node ' + process.version + ' is not the pinned ' + pinned);
if (!sqlite) problems.push('native SQLite did not load');
const git = version('git', ['--version']);
if (!git) problems.push('git is unavailable');
if (meteredKeysPresent.length)
  problems.push('metered API keys are set: ' + meteredKeysPresent.join(', '));
const qualified = Object.values(runtimes).filter(
  (r) => r.status === 'qualified',
);
if (!qualified.length) problems.push('no external runtime is qualified');
const report = {
  gateId: 'G00',
  status: problems.length ? 'failed' : 'passed',
  generatedAt: new Date().toISOString(),
  classification: 'offline',
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  pinnedNodeVersion: pinned,
  gitVersion: git,
  sqliteVersion: sqlite,
  sourceHash: sourceHash(root),
  runtimes,
  billing: {
    meteredKeysPresent,
    scope:
      'No metered-API key is visible to XVANT. Account type and plan are not read here; the live G03 receipts record what each runtime reported.',
  },
  problems,
  limitations: [
    'A runtime that is not qualified is recorded, not fixed: its workers stay disabled until its version is re-qualified.',
    'Version discovery does not prove a runtime can run a turn; the live gates do.',
    'Windows only; Linux is deferred by the operator.',
  ],
};
const receiptFile = resolve(root, 'docs/evidence/G00.json');
writeFileSync(receiptFile, JSON.stringify(report, null, 2) + '\n');
for (const [kind, found] of Object.entries(runtimes))
  console.log(
    kind.padEnd(9) + found.status.padEnd(18) + (found.version ?? 'unknown'),
  );
for (const problem of problems) console.log(problem);
console.log('G00: ' + report.status);
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
