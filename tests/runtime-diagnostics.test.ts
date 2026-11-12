import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { DiscoveredRuntime } from '../packages/adapters/src/live/discover.ts';
import { LIVE_ROUTES } from '../packages/contracts/src/live.ts';
import type { ProviderKind } from '../packages/contracts/src/providers.ts';

const mocks = vi.hoisted(() => {
  const forbidden = () => {
    throw new Error('Unexpected CLI side effect');
  };
  const stopped = new Error('Stopped after discovery diagnostics');
  return {
    stopped,
    discoverRuntime: vi.fn<(kind: ProviderKind) => DiscoveredRuntime>(),
    realpathSync: vi.fn((path: string) => path),
    spawnSync: vi.fn(),
    spawn: vi.fn(forbidden),
    mkdirSync: vi.fn(forbidden),
    readFileSync: vi.fn(forbidden),
    Store: vi.fn(forbidden),
    ArtifactStore: vi.fn(forbidden),
    Orchestrator: vi.fn(forbidden),
    LiveTurnRunner: vi.fn(forbidden),
    lessonsLine: vi.fn(forbidden),
    activeRouting: vi.fn(forbidden),
    applyRouting: vi.fn(forbidden),
    applyTiers: vi.fn(forbidden),
    shellCheck: vi.fn(forbidden),
    defaultWorkers: vi.fn(() => {
      throw stopped;
    }),
  };
});

vi.mock('node:fs', () => ({
  mkdirSync: mocks.mkdirSync,
  readFileSync: mocks.readFileSync,
  realpathSync: mocks.realpathSync,
}));
vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
  spawn: mocks.spawn,
}));
vi.mock('../packages/adapters/src/live/discover.ts', () => ({
  discoverRuntime: mocks.discoverRuntime,
}));
vi.mock('../packages/memory/src/lessons.ts', () => ({
  lessonsLine: mocks.lessonsLine,
}));
vi.mock('../packages/storage/src/store.ts', () => ({ Store: mocks.Store }));
vi.mock('../packages/storage/src/artifacts.ts', () => ({
  ArtifactStore: mocks.ArtifactStore,
}));
vi.mock('../apps/controller/src/orchestrator.ts', () => ({
  Orchestrator: mocks.Orchestrator,
}));
vi.mock('../apps/controller/src/turn-runner.ts', () => ({
  LiveTurnRunner: mocks.LiveTurnRunner,
}));
vi.mock('../apps/controller/src/app.ts', () => ({
  defaultWorkers: mocks.defaultWorkers,
  shellCheck: mocks.shellCheck,
}));
vi.mock('../apps/controller/src/routing-default.ts', () => ({
  activeRouting: mocks.activeRouting,
  applyRouting: mocks.applyRouting,
  applyTiers: mocks.applyTiers,
}));

const kinds: ProviderKind[] = ['codex', 'claude', 'opencode'];
const repository = resolve('mock-runtime-diagnostics-repo');
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('XVANT_HOME', resolve('mock-runtime-diagnostics-home'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('Unexpected process.exit');
  });
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: repository + '\n' });
});

afterEach(() => {
  try {
    for (const mock of [
      mocks.spawn,
      mocks.mkdirSync,
      mocks.readFileSync,
      mocks.Store,
      mocks.ArtifactStore,
      mocks.Orchestrator,
      mocks.LiveTurnRunner,
      mocks.lessonsLine,
      mocks.activeRouting,
      mocks.applyRouting,
      mocks.applyTiers,
      mocks.shellCheck,
      process.exit,
      console.error,
    ])
      expect(mock).not.toHaveBeenCalled();
  } finally {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.resetModules();
  }
});

function runtime(
  runtimeKind: ProviderKind,
  status: DiscoveredRuntime['status'],
  version: string | null = null,
): DiscoveredRuntime {
  return {
    runtimeKind,
    status,
    version,
    executable: status === 'unavailable' ? null : '/mock/' + runtimeKind,
    expectedVersion: LIVE_ROUTES[runtimeKind].runtimeVersion,
    candidates: status === 'unavailable' ? 0 : 1,
  };
}

async function execute(command: 'runtimes' | 'run', found: DiscoveredRuntime) {
  mocks.discoverRuntime.mockImplementation((kind) =>
    kind === found.runtimeKind ? found : runtime(kind, 'unavailable'),
  );
  process.argv = [
    process.execPath,
    'scripts/xvant.mjs',
    command,
    ...(command === 'run'
      ? [
          '--repo',
          repository,
          '--objective',
          'diagnostics',
          '--only',
          found.runtimeKind,
        ]
      : []),
  ];
  // A fresh import executes the real command branch with this case's argv.
  const entrypoint = '../scripts/xvant.mjs';
  const execution = import(entrypoint);
  if (command === 'run') {
    await expect(execution).rejects.toBe(mocks.stopped);
    expect(mocks.defaultWorkers).toHaveBeenCalledExactlyOnceWith(
      found.status === 'qualified' ? [found.runtimeKind] : [],
    );
    expect(mocks.realpathSync).toHaveBeenCalledExactlyOnceWith(repository);
    expect(mocks.spawnSync).toHaveBeenCalledExactlyOnceWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: repository, encoding: 'utf8' },
    );
  } else {
    await execution;
    expect(mocks.defaultWorkers).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.realpathSync).not.toHaveBeenCalled();
  }
  expect(mocks.discoverRuntime.mock.calls).toEqual(
    (command === 'run' ? [found.runtimeKind] : kinds).map((kind) => [kind]),
  );
  // All CLI log arguments here are strings; console.log joins them with spaces.
  return vi.mocked(console.log).mock.calls.map((args) => args.join(' '));
}

describe.each(['runtimes', 'run'] as const)(
  '%s runtime diagnostics',
  (command) => {
    it.each([
      ['codex', '0.161.0', '0.158.0-alpha.2.1, 0.160.1 or later 0.160 patches'],
      ['claude', '2.2.0', '2.1.285 or later 2.1 patches'],
      ['opencode', '2.1.0', '2.0.19 or later 2.0 patches'],
    ] as const)(
      'explains accepted versions for a %s mismatch',
      async (kind, version, accepted) => {
        const lines = await execute(
          command,
          runtime(kind, 'version_mismatch', version),
        );
        const suffix = ' (accepted: ' + accepted + ')';
        if (command === 'run')
          expect(lines).toEqual([
            'Skipping ' + kind + ': version_mismatch ' + version + suffix,
          ]);
        else
          expect(lines).toContain(
            kind.padEnd(9) +
              ' ' +
              'version_mismatch'.padEnd(17) +
              ' ' +
              version.padEnd(20) +
              ' /mock/' +
              kind +
              suffix,
          );
      },
    );

    it.each([
      ['codex', '0.158.0-alpha.2.1'],
      ['codex', '0.160.4'],
      ['claude', '2.1.299'],
      ['opencode', '2.0.20'],
    ] as const)('preserves qualified %s %s output', async (kind, version) => {
      const lines = await execute(command, runtime(kind, 'qualified', version));
      if (command === 'run') expect(lines).toEqual([]);
      else
        expect(lines).toContain(
          kind.padEnd(9) +
            ' ' +
            'qualified'.padEnd(17) +
            ' ' +
            version.padEnd(20) +
            ' /mock/' +
            kind,
        );
      expect(lines.join('\n')).not.toContain('accepted:');
      expect(lines.join('\n')).not.toContain('Skipping');
    });

    it.each(['unavailable', 'failed'] as const)(
      'preserves %s output without accepted versions',
      async (status) => {
        const lines = await execute(command, runtime('codex', status));
        if (command === 'run')
          expect(lines).toEqual(['Skipping codex: ' + status]);
        else
          expect(lines).toContain(
            'codex    ' +
              ' ' +
              status.padEnd(17) +
              ' ' +
              '-'.padEnd(20) +
              ' ' +
              (status === 'failed' ? '/mock/codex' : ''),
          );
        expect(lines.join('\n')).not.toContain('accepted:');
      },
    );
  },
);
