// Bounded live smoke for one runtime: a fixture repo, an isolated worktree, one
// small file-writing task, host checks and explicit acceptance after restart.
// Usage: node scripts/live-worker-smoke.mjs --approve-live --runtime codex|claude --executable ABS_PATH
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { createWorktree } from '../packages/storage/src/git-workspace.ts';
import { LIVE_ROUTES } from '../packages/contracts/src/live.ts';
import { NativeReviewController } from '../apps/controller/src/native-review.ts';
import { archiveRun, sourceHash } from './evidence-bundle.ts';

const args = process.argv.slice(2);
const runtime = args[args.indexOf('--runtime') + 1];
const executable = args[args.indexOf('--executable') + 1];
if (
  !args.includes('--approve-live') ||
  !['codex', 'claude', 'opencode'].includes(runtime) ||
  !executable ||
  !isAbsolute(executable)
) {
  console.error(
    'Usage: node scripts/live-worker-smoke.mjs --approve-live --runtime codex|claude|opencode --executable ABS_PATH. One subscription or free-model turn; no API key fallback.',
  );
  process.exit(2);
}
const { LiveCodexController } =
  await import('../apps/controller/src/codex-live.ts');
const { LiveClaudeController } =
  runtime === 'claude'
    ? await import('../apps/controller/src/claude-live.ts')
    : {};
const root =
  realpathSync(resolve('.artifacts')) + '/live-' + runtime + '-' + Date.now();
mkdirSync(root, { recursive: true });
const repo = join(root, 'repo');
mkdirSync(repo);
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# live smoke\n');
git('add', '.');
git(
  '-c',
  'user.name=xvant',
  '-c',
  'user.email=xvant@local',
  'commit',
  '-qm',
  'base',
);
const tree = createWorktree(
  repo,
  'main',
  join(root, 'wt'),
  'xvant/' + runtime + '-1',
);
let store = new Store(join(root, 'state.sqlite'), { owner: 'live-smoke' });
const objects = new ArtifactStore(join(root, 'objects'));
const expected = 'hi from ' + runtime;
store.create('create', {
  id: 'task',
  projectId: 'live-smoke',
  objective:
    'Create a file named hello.txt in the current directory whose entire content is the single line: ' +
    expected +
    '. Do not create or change anything else.',
  requiredCheckIds: ['check'],
  acceptanceCriteria: ['hello.txt has the exact line'],
});
store.queue('queue', 'task', 0);
const route = LIVE_ROUTES[runtime];
const report = {
  generatedAt: new Date().toISOString(),
  classification: 'live',
  scope: runtime + '-workspace-write-smoke',
  runtimeVersion: route.runtimeVersion,
  adapterVersion: route.adapterVersion,
  stateDirectory: root,
  sourceHash: sourceHash(resolve('.')),
  events: 0,
};
const { LiveOpenCodeController } =
  await import('../apps/controller/src/opencode-live.ts');
const Controller = {
  codex: LiveCodexController,
  claude: LiveClaudeController,
  opencode: LiveOpenCodeController,
}[runtime];
const controller = new Controller(
  store,
  objects,
  { workspace: tree.path },
  {
    check: {
      executable: process.execPath,
      args: [
        '-e',
        `if(require('node:fs').readFileSync('hello.txt','utf8').trim()!==${JSON.stringify(expected)})process.exit(1)`,
      ],
    },
  },
  {
    executable,
    timeoutMs: 15 * 60 * 1000,
    gitBases: { workspace: tree.baseCommit },
    onEvent: (e) => {
      report.events++;
      if (e.kind !== 'text')
        console.log('[' + e.kind + ']', e.text.slice(0, 120));
    },
  },
);
try {
  const dispatch = (d) =>
    runtime === 'opencode'
      ? controller.runLive(d)
      : controller.run(d, 'create');
  const result = await dispatch({
    connectionId: 'connection',
    taskId: 'task',
    attemptId: 'attempt',
    workspaceId: 'workspace',
    expectedVersion: 1,
    classification: 'live',
    liveApproval: {
      actorId: 'operator',
      model: runtime === 'opencode' ? 'opencode/big-pickle' : 'default',
      transport: route.transport,
      userApprovedTrustedLocal: true,
      profile: 'workspace-write',
      acknowledgedNativeBypass: true,
    },
    worker: {
      id: runtime + '-1',
      alias: runtime + '-1',
      runtimeKind: runtime,
      hostId: 'local',
      endpointId: route.transport,
      // Claude sessions are host-chosen UUIDs; Codex returns its own thread ID.
      nativeSessionId:
        runtime === 'claude' ? randomUUID() : 'pending:connection',
      runtimeVersion: route.runtimeVersion,
      adapterVersion: route.adapterVersion,
      mode: 'managed',
      quotaGroupId: runtime + '-subscription',
    },
  });
  const saved = store.providers.get('connection');
  Object.assign(report, {
    state: result.task.state,
    finalText: result.finalText.slice(0, 500),
    tokens: result.tokens,
    auth: result.auth,
    sessionId: saved.worker.nativeSessionId,
    runId: saved.nativeRunId,
    outcome: saved.outcome,
    verification: saved.verification?.status,
    failure: saved.failure ?? null,
    activeCount: controller.activeCount,
  });
  controller.stop();
  store.close();
  store = new Store(join(root, 'state.sqlite'), { owner: 'live-smoke' });
  if (result.task.state === 'ready_for_acceptance') {
    const prepared = store
      .events(0)
      .find((e) => e.kind === 'native.ready_for_acceptance').payload;
    const accepted = new NativeReviewController(store, objects).accept(
      'accept',
      {
        connectionId: 'connection',
        expectedVersion: prepared.rowVersion,
        reviewedEvidenceHash: prepared.evidenceHash,
        actorId: 'fixture-reviewer',
        classification: 'live',
      },
    );
    report.acceptedAfterRestart = accepted.state === 'accepted';
  }
  report.status = report.acceptedAfterRestart ? 'passed' : 'failed';
} catch (e) {
  report.status = 'failed';
  report.error = e.message;
} finally {
  controller.stop();
  store.close();
}
mkdirSync('docs/evidence', { recursive: true });
const file = 'docs/evidence/G03-' + runtime + '-live.json';
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 1;
// Live runs cannot be replayed; keep the durable state and worktree beside the receipt.
try {
  const bundle = archiveRun({
    receiptFile: file,
    sourceRoot: '.',
    destination: 'docs/evidence/runs',
    extras: [
      relative(resolve('.'), join(root, 'state.sqlite')),
      relative(resolve('.'), join(root, 'objects')),
    ],
  });
  console.log('evidence bundle: ' + bundle.bundleId);
} catch (e) {
  console.error('Evidence archival failed: ' + e.message);
  process.exitCode = 1;
}
