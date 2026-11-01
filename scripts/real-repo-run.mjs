// A real-repository run with a receipt.
// Usage: node scripts/real-repo-run.mjs --approve-live --repo PATH --objective TEXT
//          --check "COMMAND" [--check ...] [any other `xvant run` option]
// Runs `xvant run` in its own state directory and writes
// docs/evidence/G07-live-ui.json. The run passes only if the result is ready,
// every registered check passed, the review approved, and neither this source
// tree nor the repository's own checkout changed. Use a throwaway clone.
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Store } from '../packages/storage/src/store.ts';
import { discoverRuntime } from '../packages/adapters/src/live/discover.ts';
import { archiveRun, sourceHash } from './evidence-bundle.ts';
import { realRepoProblems } from './real-repo-policy.ts';

const args = process.argv.slice(2);
const values = (name) =>
  args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : [])).filter(Boolean);
const repo = values('--repo')[0];
if (
  !args.includes('--approve-live') ||
  !repo ||
  !values('--objective')[0] ||
  !values('--check').length
) {
  console.error(
    'Usage: node scripts/real-repo-run.mjs --approve-live --repo PATH --objective TEXT --check "COMMAND" [xvant run options]\nThis runs real model turns. A run without a check proves nothing, so one is required.',
  );
  process.exit(2);
}
const root = resolve('.');
const repository = realpathSync(resolve(repo));
const git = (...command) =>
  spawnSync('git', command, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  }).stdout.trim();
// What XVANT promises never to change: the checkout and its branches.
const checkout = () => ({
  head: git('rev-parse', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  status: git('status', '--porcelain'),
});
const gateId = 'G07-live-ui';
const only = (values('--only')[0] ?? 'codex,claude,opencode').split(',');
const report = {
  gateId,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  classification: 'live',
  // The requirement is named for the UI; this run goes through the same
  // orchestrator from the command line.
  surface: 'cli',
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  sourceHash: sourceHash(root),
  repository: {
    path: repository,
    // A remote URL may carry a token; the receipt keeps the URL without it.
    origin:
      git('config', '--get', 'remote.origin.url').replace(
        /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i,
        '$1',
      ) || null,
    before: checkout(),
  },
  objective: values('--objective')[0],
  acceptanceCriteria: values('--criterion'),
  checks: values('--check'),
  models: { runtime: values('--model'), planner: values('--planner-model')[0] },
  runtimes: Object.fromEntries(only.map((k) => [k, discoverRuntime(k)])),
  limitations: [
    'One objective on one repository, run from the command line rather than the UI.',
    'Trusted-local: native runtime tools edit their own worktree and bypass XVANT approvals and receipts.',
    'The evidence bundle holds the run state, including model transcripts and what the workers read from the repository. Do not use a repository with secrets in it.',
    'Qualifies this host and these runtime versions only; Linux is deferred by the operator.',
  ],
  problems: [],
};
mkdirSync('.artifacts', { recursive: true });
const state = join(
  realpathSync(resolve('.artifacts')),
  'real-repo-' + Date.now(),
);
mkdirSync(state, { recursive: true });
const started = Date.now();
const run = spawnSync(
  process.execPath,
  [
    join(root, 'scripts', 'xvant.mjs'),
    'run',
    ...args.filter((a) => a !== '--approve-live'),
  ],
  {
    cwd: root,
    env: { ...process.env, XVANT_HOME: state },
    stdio: 'inherit',
    windowsHide: true,
  },
);
report.elapsedMs = Date.now() - started;
report.exitCode = run.status;
let facts = null;
try {
  const store = new Store(join(state, 'state.sqlite'), { owner: 'receipt' });
  try {
    const [graph] = store.graphs.list();
    if (!graph) throw new Error('no root task');
    const { state: result } = store.graphs.get(graph.id);
    report.run = {
      id: graph.id,
      phase: result.phase,
      reason: result.reason ?? null,
      nodes: Object.values(result.nodes).map((n) => ({
        id: n.node.id,
        title: n.node.title,
        status: n.status,
        repairs: n.repairs,
        attempts: n.attempts.map((a) => ({
          alias: a.alias,
          status: a.status,
          files: a.files,
        })),
      })),
      checks: result.checks,
      review: result.review,
      reviewRepairs: result.reviewRepairs ?? 0,
      integration: result.integration && {
        branch: result.integration.branch,
        baseCommit: result.integration.baseCommit,
        head: result.integration.head,
      },
      events: store.graphs.events(graph.id).map((e) => e.kind),
    };
    facts = result;
  } finally {
    store.close();
  }
} catch (error) {
  report.problems.push('Cannot read the run: ' + error.message);
}
report.repository.after = checkout();
report.problems.push(
  ...realRepoProblems({
    run: facts,
    before: report.repository.before,
    after: report.repository.after,
    sourceBefore: report.sourceHash,
    sourceAfter: sourceHash(root),
  }),
);
report.status = report.problems.length === 0 ? 'passed' : 'failed';
mkdirSync('docs/evidence', { recursive: true });
const receipt = 'docs/evidence/' + gateId + '.json';
writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n');
console.log(gateId + ': ' + report.status);
if (report.problems.length) console.log(report.problems.join('\n'));
process.exitCode = report.status === 'passed' ? 0 : 1;
try {
  const bundle = archiveRun({
    receiptFile: receipt,
    sourceRoot: root,
    destination: 'docs/evidence/runs',
    extras: [
      relative(root, join(state, 'state.sqlite')),
      relative(root, join(state, 'objects')),
    ].filter((p) => {
      try {
        return realpathSync(join(root, p));
      } catch {
        return false;
      }
    }),
  });
  console.log('evidence bundle: ' + bundle.bundleId);
} catch (error) {
  console.error('Evidence archival failed: ' + error.message);
  process.exitCode = 1;
}
