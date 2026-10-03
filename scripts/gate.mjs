import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, platform, release } from 'node:os';
import { validateTestReport, phaseSuites } from './gate-policy.ts';
import { runBounded } from './bounded-run.ts';
import { archiveRun } from './evidence-bundle.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (
  args.length !== 3 ||
  args[0] !== '--phase' ||
  !['01', '02', '03', '04', '05', '06', '07', '08'].includes(args[1]) ||
  args[2] !== '--offline'
) {
  console.error(
    'Usage: npm run gate -- --phase 01|02|03|04|05|06|07|08 --offline. Live gates run through scripts/live-gate.mjs.',
  );
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
  qualificationScope:
    phase === '08'
      ? 'offline-native-loop'
      : phase === '07'
        ? 'offline-local-app'
        : phase === '06'
          ? 'offline-orchestration'
          : phase === '05'
            ? 'offline-tools-skills'
            : phase === '04'
              ? 'offline-context-handoff'
              : phase === '03'
                ? 'offline-provider-transport-foundation'
                : 'offline-simulation',
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
async function check(id, args) {
  const startedAt = new Date().toISOString();
  const log = resolve(artifacts, id + '.log');
  const child = await runBounded(process.execPath, args, {
    cwd: root,
    // The full Windows coverage suite includes bounded process-death tests.
    timeoutMs: id === 'tests' ? 600000 : 180000,
    logPath: log,
  });
  const result = {
    id,
    command: [process.execPath, ...args],
    workingDirectory: root,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: child.exitCode,
    ...(child.timedOut ? { timedOut: true } : {}),
  };
  report.checks.push(result);
  report.artifacts.push({
    path: relative(root, log).replaceAll('\\', '/'),
    sha256: hash(readFileSync(log)),
  });
  console.log(id + ': ' + (result.exitCode === 0 ? 'passed' : 'FAILED'));
  if (result.exitCode !== 0) console.error(child.output);
  return result;
}
try {
  const before = snapshot();
  report.dirtyTreeHash = before.sha256;
  const pinned = readFileSync(resolve(root, '.node-version'), 'utf8').trim();
  if (process.version !== 'v' + pinned)
    throw new Error('Use pinned Node ' + pinned + '; found ' + process.version);
  await check('typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']);
  await check('lint', [
    'node_modules/eslint/bin/eslint.js',
    'packages',
    'apps',
    'scripts',
    'tests',
  ]);
  await check('format', [
    'node_modules/prettier/bin/prettier.cjs',
    '--check',
    '.',
  ]);
  const tests = await check('tests', [
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
  await check(
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
  if (Number(phase) >= 3) {
    await check('provider-fixtures', [
      'scripts/probe.mjs',
      '--offline',
      '--runtime',
      'all',
    ]);
    const fixtures = JSON.parse(
      readFileSync(resolve(artifacts, 'provider-fixtures.log'), 'utf8'),
    );
    if (
      fixtures.classification !== 'offline' ||
      fixtures.liveProvidersTested.length !== 0 ||
      fixtures.results.length !== 10 ||
      !fixtures.results.every(
        (r) => r.liveEnabled === false && r.outcome === 'completed',
      )
    )
      throw new Error('Provider fixture roster failed');
    await check('controller-roster', ['scripts/roster-fixture.mjs']);
    const roster = JSON.parse(
      readFileSync(resolve(artifacts, 'controller-roster.log'), 'utf8'),
    );
    if (
      roster.classification !== 'offline' ||
      roster.liveProvidersTested.length !== 0 ||
      roster.workers !== 10 ||
      roster.problems.length !== 0 ||
      roster.activeCount !== 0 ||
      roster.accepted !== false
    )
      throw new Error('Controller roster failed');
    for (const scenario of ['permission', 'interrupt', 'no-auth']) {
      const checkId = 'opencode-http-' + scenario;
      await check(checkId, ['scripts/opencode-http-fixture.mjs', scenario]);
      const http = JSON.parse(
        readFileSync(resolve(artifacts, checkId + '.log'), 'utf8'),
      );
      const common =
        http.classification === 'offline' &&
        http.liveProvidersTested.length === 0 &&
        http.activeCount === 0 &&
        http.accepted === false &&
        http.methods[0] === 'opencode/serve';
      const specific =
        scenario === 'permission'
          ? http.state === 'ready_for_acceptance' &&
            http.verification === 'passed' &&
            http.endpointBound &&
            http.loopback &&
            http.methods.includes('permission/reply')
          : scenario === 'interrupt'
            ? http.outcome === 'cancelled' &&
              http.interruptAdmission === 'requested' &&
              http.methods.at(-1) === 'session/abort'
            : http.status === 'unknown' &&
              !http.endpointBound &&
              http.methods.length === 1;
      if (!common || !specific)
        throw new Error('OpenCode HTTP fixture failed: ' + scenario);
    }
    await check('codex-transport', ['scripts/codex-fixture.mjs', 'success']);
    const transport = JSON.parse(
      readFileSync(resolve(artifacts, 'codex-transport.log'), 'utf8'),
    );
    if (
      transport.classification !== 'offline' ||
      transport.liveProvidersTested.length !== 0 ||
      transport.state !== 'result_pending' ||
      transport.outcome !== 'completed' ||
      transport.persistedBeforeWrite !== true ||
      transport.turnRequests !== 1
    )
      throw new Error('Codex offline transport failed');
    for (const kind of ['claude', 'opencode']) {
      await check(kind + '-native-stream', [
        'scripts/native-fixture.mjs',
        kind,
        'permission',
      ]);
      const stream = JSON.parse(
        readFileSync(resolve(artifacts, kind + '-native-stream.log'), 'utf8'),
      );
      if (
        stream.classification !== 'offline' ||
        stream.liveProvidersTested.length ||
        stream.outcome !== 'completed' ||
        stream.denials !== 1 ||
        stream.activeCount !== 0
      )
        throw new Error('Native stream fixture failed');
      await check(kind + '-native-controller', [
        'scripts/native-controller-fixture.mjs',
        kind,
      ]);
      const controller = JSON.parse(
        readFileSync(
          resolve(artifacts, kind + '-native-controller.log'),
          'utf8',
        ),
      );
      if (
        controller.classification !== 'offline' ||
        controller.liveProvidersTested.length ||
        controller.state !== 'ready_for_acceptance' ||
        controller.verification !== 'passed' ||
        controller.interruptAdmission !== null ||
        controller.journalEntries !== (kind === 'claude' ? 8 : 6) ||
        controller.activeCount !== 0 ||
        controller.accepted !== false
      )
        throw new Error('Native controller fixture failed');
      await check(kind + '-native-interrupt', [
        'scripts/native-controller-fixture.mjs',
        kind,
        'interrupt',
      ]);
      const interruption = JSON.parse(
        readFileSync(
          resolve(artifacts, kind + '-native-interrupt.log'),
          'utf8',
        ),
      );
      if (
        interruption.classification !== 'offline' ||
        interruption.liveProvidersTested.length ||
        interruption.state !== 'needs_attention' ||
        interruption.outcome !== 'cancelled' ||
        interruption.interruptAdmission !== 'requested' ||
        interruption.interruptActor !== 'operator' ||
        interruption.verification !== undefined ||
        interruption.activeCount !== 0 ||
        interruption.accepted !== false
      )
        throw new Error('Native interrupt fixture failed');
      await check(kind + '-native-quota', [
        'scripts/native-controller-fixture.mjs',
        kind,
        'quota-error',
      ]);
      const quota = JSON.parse(
        readFileSync(resolve(artifacts, kind + '-native-quota.log'), 'utf8'),
      );
      if (
        quota.classification !== 'offline' ||
        quota.liveProvidersTested.length ||
        quota.state !== 'needs_attention' ||
        quota.outcome !== 'failed' ||
        quota.failure?.code !== 'QUOTA_BLOCKED' ||
        quota.failure?.scope !== 'quota_group' ||
        quota.blocked !== 'QUOTA_BLOCKED' ||
        quota.verification !== undefined ||
        quota.activeCount !== 0 ||
        quota.accepted !== false
      )
        throw new Error('Native quota fixture failed');
      for (const scenario of ['permission', 'interrupt']) {
        const checkId = kind + '-create-' + scenario;
        await check(checkId, [
          'scripts/native-controller-fixture.mjs',
          kind,
          scenario,
          'create',
        ]);
        const created = JSON.parse(
          readFileSync(resolve(artifacts, checkId + '.log'), 'utf8'),
        );
        if (
          created.classification !== 'offline' ||
          created.liveProvidersTested.length ||
          created.sessionBound !== (kind === 'opencode') ||
          created.nativeSessionId !==
            (kind === 'opencode'
              ? 'created-1'
              : '6306ed11-5ca4-4c61-a177-5b64eddf5d5b') ||
          created.activeCount !== 0 ||
          created.accepted !== false ||
          (scenario === 'permission'
            ? created.state !== 'ready_for_acceptance' ||
              created.verification !== 'passed'
            : created.state !== 'needs_attention' ||
              created.outcome !== 'cancelled' ||
              created.interruptAdmission !== 'requested' ||
              created.verification !== undefined)
        )
          throw new Error('Native session creation fixture failed');
      }
    }
  }
  if (Number(phase) >= 4) {
    await check('handoff-fixture', ['scripts/handoff-fixture.mjs']);
    const handoff = JSON.parse(
      readFileSync(resolve(artifacts, 'handoff-fixture.log'), 'utf8'),
    );
    if (
      handoff.classification !== 'offline' ||
      handoff.liveProvidersTested.length !== 0 ||
      handoff.problems.length !== 0 ||
      handoff.from === handoff.to ||
      handoff.recipient.completed !== true ||
      handoff.sentinelsAbsent !== true ||
      handoff.requiredFacts.present !== handoff.requiredFacts.expected
    )
      throw new Error('Handoff fixture failed');
  }
  if (Number(phase) >= 5) {
    await check('tools-fixture', ['scripts/tools-fixture.mjs']);
    const tools = JSON.parse(
      readFileSync(resolve(artifacts, 'tools-fixture.log'), 'utf8'),
    );
    if (
      tools.classification !== 'offline' ||
      tools.liveProvidersTested.length !== 0 ||
      tools.problems.length !== 0 ||
      Object.keys(tools.checks).length < 14 ||
      !Object.values(tools.checks).every((value) => value === true)
    )
      throw new Error('Tools fixture failed');
    await check('compatibility-report', ['scripts/compatibility-report.mjs']);
    const compatibility = JSON.parse(
      readFileSync(resolve(artifacts, 'compatibility-report.log'), 'utf8'),
    );
    const externalRestricted = compatibility.rows.filter(
      (row) =>
        ['codex', 'claude', 'opencode'].includes(row.runtime) &&
        row.profile === 'read-only',
    );
    if (
      compatibility.rows.length !== 100 ||
      externalRestricted.length !== 30 ||
      !externalRestricted.every((row) => row.status === 'blocked')
    )
      throw new Error('Compatibility report failed');
    // A missing browser exits 2 and fails the gate: unavailable is not a pass.
    await check('browser-fixture', ['scripts/browser-fixture.mjs']);
    const browser = JSON.parse(
      readFileSync(resolve(artifacts, 'browser-fixture.log'), 'utf8'),
    );
    if (
      browser.status !== 'succeeded' ||
      !browser.profileRemoved ||
      browser.activeCount !== 0 ||
      !browser.blockedRequests.some((url) =>
        url.startsWith('http://example.com/'),
      )
    )
      throw new Error('Browser fixture failed');
  }
  if (Number(phase) >= 6) {
    await check('orchestration-fixture', ['scripts/orchestration-fixture.mjs']);
    const run = JSON.parse(
      readFileSync(resolve(artifacts, 'orchestration-fixture.log'), 'utf8'),
    );
    if (
      run.classification !== 'offline' ||
      run.liveProvidersTested.length !== 0 ||
      run.phase !== 'ready' ||
      !run.combined ||
      !run.userCheckoutUntouched ||
      !run.dependencyOrder ||
      !run.checks.every((status) => status === 'passed') ||
      Object.values(run.nodes).some((node) => node.status !== 'integrated')
    )
      throw new Error('Orchestration fixture failed');
  }
  if (Number(phase) >= 8) {
    await check('native-loop-fixture', ['scripts/native-loop-fixture.mjs']);
    const native = JSON.parse(
      readFileSync(resolve(artifacts, 'native-loop-fixture.log'), 'utf8'),
    );
    if (
      native.classification !== 'offline' ||
      native.liveProvidersTested.length !== 0 ||
      native.runtimeKind !== 'native-local' ||
      native.problems.length !== 0 ||
      Object.keys(native.checks).length < 11 ||
      !Object.values(native.checks).every((value) => value === true) ||
      Object.keys(native.skills).length !== 10 ||
      !Object.values(native.skills).every((value) => value === 'passed')
    )
      throw new Error('Native loop fixture failed');
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
const receiptFile = resolve(root, 'docs/evidence/' + gateId + '.json');
writeFileSync(receiptFile, JSON.stringify(report, null, 2) + '\n');
console.log(gateId + ': ' + report.status);
process.exitCode = report.status === 'passed' ? 0 : 1;
// The next run overwrites .artifacts; keep this run's bytes. Failed runs too.
try {
  const bundle = archiveRun({
    receiptFile,
    sourceRoot: root,
    destination: resolve(root, 'docs/evidence/runs'),
  });
  console.log('evidence bundle: ' + bundle.bundleId + ' ' + bundle.integrity);
  if (report.status === 'passed' && bundle.integrity !== 'complete')
    throw new Error('Declared artifacts changed before archival');
} catch (error) {
  console.error('Evidence archival failed: ' + error.message);
  process.exitCode = 1;
}
