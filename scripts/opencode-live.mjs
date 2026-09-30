import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { archiveRun } from './evidence-bundle.ts';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { LiveOpenCodeController } from '../apps/controller/src/opencode-live.ts';
import { NativeReviewController } from '../apps/controller/src/native-review.ts';

// Explicit, provider-specific qualification. Never substitutes for the mixed live G03 roster.
const args = process.argv.slice(2);
if (
  args.length !== 3 ||
  args[0] !== '--approve-live' ||
  args[1] !== '--executable' ||
  !isAbsolute(args[2])
) {
  console.error(
    'Usage: node scripts/opencode-live.mjs --approve-live --executable ABSOLUTE_OPENCODE_2_0_19_PATH. Runs two bounded Big Pickle text turns, host checks, and explicit fixture acceptance. No paid fallback.',
  );
  process.exit(2);
}
const root = resolve('.artifacts/opencode-live-' + Date.now());
mkdirSync(root, { recursive: true });
const workspace = join(root, 'work');
mkdirSync(workspace);
const token = 'XVANT_LIVE_' + randomBytes(8).toString('hex');
const report = {
  generatedAt: new Date().toISOString(),
  classification: 'live',
  scope: 'opencode-cli-durable-text',
  runtimeVersion: '2.0.19',
  model: 'opencode/big-pickle',
  fullMixedG03: false,
  stateDirectory: root,
  checks: [],
};
let store = new Store(join(root, 'state.sqlite'), {
  owner: 'live-qualification',
});
const objects = new ArtifactStore(join(root, 'objects'));
let controller;
try {
  const git = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (git.status !== 0) throw new Error('SOURCE_INVENTORY_FAILED');
  const files = [...new Set(git.stdout.split('\0').filter(Boolean))]
    .filter((p) => !p.startsWith('docs/evidence/'))
    .sort()
    .map((path) => ({
      path,
      sha256: existsSync(path)
        ? createHash('sha256').update(readFileSync(path)).digest('hex')
        : 'deleted',
    }));
  report.sourceHash = createHash('sha256')
    .update(JSON.stringify(files))
    .digest('hex');
  for (const turn of [1, 2]) {
    const taskId = 'task' + turn,
      attemptId = 'attempt' + turn,
      connectionId = 'connection' + turn;
    store.create('create' + turn, {
      id: taskId,
      projectId: 'live-probe',
      objective:
        turn === 1
          ? 'Remember this token: ' +
            token +
            '. Reply with exactly that token. Do not use tools.'
          : 'Reply with only the token I gave you in my previous message. Do not use tools.',
      requiredCheckIds: ['check'],
      acceptanceCriteria: ['Exact token output and stable verified workspace'],
    });
    store.queue('queue' + turn, taskId, 0);
    const checkCode =
      "if(require('node:fs').readFileSync(" +
      JSON.stringify('.xvant-result-' + attemptId + '.txt') +
      ",'utf8').trim()!==" +
      JSON.stringify(token) +
      ')process.exit(1)';
    controller = new LiveOpenCodeController(
      store,
      objects,
      { workspace },
      { check: { executable: process.execPath, args: ['-e', checkCode] } },
      { executable: args[2], timeoutMs: 60000 },
    );
    const task = await controller.run(
      {
        connectionId,
        taskId,
        attemptId,
        workspaceId: 'workspace',
        expectedVersion: 1,
        classification: 'live',
        liveApproval: {
          actorId: 'operator',
          model: 'opencode/big-pickle',
          transport: 'cli',
          userApprovedTrustedLocal: true,
        },
        worker: {
          id: 'worker' + turn,
          alias: 'worker' + turn,
          runtimeKind: 'opencode',
          hostId: 'local',
          endpointId: 'owned-cli',
          nativeSessionId: 'ses_pending',
          runtimeVersion: '2.0.19',
          adapterVersion: 'opencode-cli-v2',
          mode: 'managed',
          quotaGroupId: 'opencode-big-pickle',
        },
      },
      turn === 2 ? 'connection1' : undefined,
    );
    const saved = store.providers.get(connectionId);
    report.checks.push({
      turn,
      state: task.state,
      status: saved.status,
      outcome: saved.outcome,
      verification: saved.verification?.status,
      sessionId: saved.worker.nativeSessionId,
      activeCount: controller.activeCount,
    });
    if (task.state !== 'ready_for_acceptance')
      throw new Error('LIVE_VERIFICATION_FAILED');
    controller.stop();
    store.close();
    store = new Store(join(root, 'state.sqlite'), {
      owner: 'live-qualification',
    });
    const prepared = store
      .events(0)
      .find(
        (event) =>
          event.kind === 'native.ready_for_acceptance' &&
          event.payload.connectionId === connectionId,
      ).payload;
    const accepted = new NativeReviewController(store, objects).accept(
      'accept' + turn,
      {
        connectionId,
        expectedVersion: prepared.rowVersion,
        reviewedEvidenceHash: prepared.evidenceHash,
        actorId: 'fixture-reviewer',
        classification: 'live',
      },
    );
    report.checks.at(-1).acceptedAfterRestart = accepted.state === 'accepted';
    report.checks.at(-1).classification =
      accepted.nativeQualification.classification;
    console.log('live turn', turn, accepted.state);
  }
  report.sameSession =
    report.checks[0].sessionId === report.checks[1].sessionId;
  if (!report.sameSession) throw new Error('RESUME_MISMATCH');
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.error = e.message;
  process.exitCode = 1;
} finally {
  controller?.stop();
  store.close();
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync(
    'docs/evidence/G03-opencode-live.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  // Live runs are not replayable; keep the durable state beside the receipt.
  try {
    const bundle = archiveRun({
      receiptFile: 'docs/evidence/G03-opencode-live.json',
      sourceRoot: '.',
      destination: 'docs/evidence/runs',
      extras: [relative(resolve('.'), root)],
    });
    console.log('evidence bundle: ' + bundle.bundleId);
  } catch (e) {
    console.error('Evidence archival failed: ' + e.message);
    process.exitCode = 1;
  }
}
