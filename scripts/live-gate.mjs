// Live gates. Each one uses real subscription or free-model sessions, so it
// runs only with --approve-live and never retries or falls back to an API key.
// Usage: node scripts/live-gate.mjs --phase 03 --fixture roster --approve-live [--concurrency N]
//        node scripts/live-gate.mjs --phase 08 --fixture native --approve-live --model <id> [--endpoint http://127.0.0.1:1234/v1]
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { archiveRun, sourceHash } from './evidence-bundle.ts';
import { discoverRuntime } from '../packages/adapters/src/live/discover.ts';

const args = process.argv.slice(2);
const value = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const FIXTURES = {
  '03': ['roster'],
  '04': ['handoff'],
  '05': ['mcp'],
  '06': ['parallel-feature'],
  '08': ['native'],
};
const phase = value('--phase');
const fixture = value('--fixture');
if (!args.includes('--approve-live') || !FIXTURES[phase]?.includes(fixture)) {
  console.error(
    'Usage: node scripts/live-gate.mjs --phase 03|04|05|06|08 --fixture roster|handoff|mcp|parallel-feature|native --approve-live [--concurrency N] [--model <id> --endpoint <loopback url>]. Uses real subscription, free-model and local-model sessions.',
  );
  process.exit(2);
}
const concurrency = Number(value('--concurrency') ?? 3);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) {
  console.error('--concurrency must be 1-10');
  process.exit(2);
}
const native = fixture === 'native';
const model = value('--model');
if (native && !model) {
  console.error('--fixture native needs --model <id> (see `lms ls`)');
  process.exit(2);
}
const root = resolve('.');
const gateId = 'G' + phase + '-live-' + fixture;
const report = {
  gateId,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  classification: 'live',
  fixture,
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  sourceHash: sourceHash(root),
  runtimes: {},
  limitations: native
    ? [
        'Qualifies this host, this local model and one small change only; it says nothing about harder tasks.',
        'Trusted-local: registry tools bound the worktree, but checks run as ordinary local processes.',
        'Linux is deferred by the operator.',
      ]
    : [
        'Trusted-local: native runtime tools edit their own worktree and bypass XVANT approvals and receipts.',
        'Qualifies this host and these runtime versions only; Linux is deferred by the operator.',
        'Token counts are what each runtime reports; subscription usage has no per-call bill.',
      ],
};
const runtimes = {};
for (const kind of native ? [] : ['codex', 'claude', 'opencode']) {
  const found = discoverRuntime(kind);
  report.runtimes[kind] = found;
  if (found.status === 'qualified')
    runtimes[kind] = { executable: found.executable, version: found.version };
}
const state = join(
  realpathSync(resolve('.artifacts')),
  'live-' + fixture + '-' + Date.now(),
);
mkdirSync(state, { recursive: true });
report.stateDirectory = state;
try {
  const missing = Object.entries(report.runtimes).filter(
    ([, found]) => found.status !== 'qualified',
  );
  if (missing.length)
    throw new Error(
      'Runtime not qualified: ' +
        missing.map(([k, f]) => k + '=' + f.status).join(', '),
    );
  const started = Date.now();
  const onEvent = (alias, event) => {
    if (event.kind !== 'text')
      console.log(
        alias.padEnd(11),
        event.kind.padEnd(8),
        event.text.slice(0, 80),
      );
  };
  let result;
  if (native) {
    const { LocalEndpointProvider } =
      await import('../packages/native-agent/src/local-endpoint.ts');
    const { runLiveNative } =
      await import('../apps/controller/src/live-native.ts');
    // Loopback HTTP only and no credential: this cannot reach a paid API.
    result = await runLiveNative(state, {
      provider: new LocalEndpointProvider({
        baseUrl: value('--endpoint') ?? 'http://127.0.0.1:1234/v1',
        model,
        server: 'lmstudio',
      }),
      classification: 'live',
      onEvent: (alias, event) =>
        console.log(
          alias.padEnd(11),
          event.kind.padEnd(8),
          event.kind === 'tool'
            ? event.tool +
                ' ' +
                event.status +
                (event.code ? ' ' + event.code : '')
            : event.kind === 'model'
              ? event.toolCalls + ' call(s) ' + event.text.slice(0, 60)
              : event.kind === 'malformed'
                ? event.reason
                : event.code,
        ),
    });
    report.native = result;
  } else if (fixture === 'roster') {
    const { runLiveRoster } =
      await import('../apps/controller/src/live-roster.ts');
    result = await runLiveRoster(state, {
      runtimes,
      concurrency,
      resume: true,
      interrupt: true,
      onEvent,
    });
    report.roster = result;
  } else if (fixture === 'handoff') {
    const { runLiveHandoff } =
      await import('../apps/controller/src/live-handoff.ts');
    result = await runLiveHandoff(state, {
      runtimes,
      from: 'codex',
      to: 'claude',
      onEvent,
    });
    report.handoff = result;
  } else if (fixture === 'parallel-feature') {
    const { runLiveParallel } =
      await import('../apps/controller/src/live-parallel.ts');
    result = await runLiveParallel(state, {
      runtimes,
      onEvent,
      onChange: (s, kind) =>
        console.log('graph'.padEnd(11), kind.padEnd(8), s.phase),
    });
    report.parallel = result;
  } else {
    const { runLiveMcp } = await import('../apps/controller/src/live-mcp.ts');
    result = await runLiveMcp(state, { runtimes, onEvent });
    report.mcp = result;
  }
  report.elapsedMs = Date.now() - started;
  report.problems = [...result.problems];
  if (sourceHash(root) !== report.sourceHash)
    report.problems.push('Source changed during the live gate');
  report.status =
    report.problems.length === 0 && (result.activeCount ?? 0) === 0
      ? 'passed'
      : 'failed';
} catch (error) {
  report.failure = error.message;
}
mkdirSync('docs/evidence', { recursive: true });
const receipt = 'docs/evidence/' + gateId + '.json';
writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n');
console.log(gateId + ': ' + report.status);
if (report.problems?.length) console.log(report.problems.join('\n'));
if (report.failure) console.log(report.failure);
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
