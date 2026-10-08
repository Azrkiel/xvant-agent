import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RoutingProfiles,
  generateCandidates,
  settingsHash,
  settingsOf,
} from './profile.ts';
import type { BenchmarkReport, ConfigurationSummary } from './report.ts';

const HASH = 'c'.repeat(64);
const orchestrated = (model: string, plannerModel?: string) => ({
  runtime: 'xvant-orchestrated',
  workerRuntime: 'claude',
  model,
  ...(plannerModel ? { plannerModel } : {}),
  orchestration: '2',
});
const summary = (
  versions: Record<string, string>,
  medianElapsedMs: number,
  over: Partial<ConfigurationSummary> = {},
): ConfigurationSummary => ({
  scheduled: 24,
  accepted: 20,
  failed: 4,
  incomplete: 0,
  excluded: 0,
  missing: 0,
  successRate: 20 / 24,
  tasksAlwaysAccepted: 20,
  medianElapsedMs,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  toolFailures: null,
  conflicts: 0,
  versions,
  ...over,
});
/** `haiku` is the default; `opus-haiku` plans on Opus; `single` is not orchestrated. */
const report = (
  held: [number, number],
  tuning: [number, number] = [9, 11],
): BenchmarkReport => ({
  suiteId: 'v1',
  frozenHash: 'f'.repeat(64),
  complete: true,
  directional: true,
  configurations: {
    haiku: summary(orchestrated('haiku'), 90_000),
    'opus-haiku': summary(orchestrated('haiku', 'opus'), 140_000),
    single: summary(
      { runtime: 'claude', workerRuntime: 'claude', model: 'haiku' },
      30_000,
    ),
  },
  bySplit: {
    'held-out': {
      haiku: { scheduled: 12, accepted: held[0] },
      'opus-haiku': { scheduled: 12, accepted: held[1] },
      single: { scheduled: 12, accepted: 12 },
    },
    tuning: {
      haiku: { scheduled: 12, accepted: tuning[0] },
      'opus-haiku': { scheduled: 12, accepted: tuning[1] },
      single: { scheduled: 12, accepted: 12 },
    },
  },
  exclusions: [],
  missing: [],
  limitations: [],
});
const DEFAULT = {
  version: 'haiku-default',
  settings: { models: { claude: 'haiku' } },
};
const gate = { safetyFixturesPassed: true, orchestration: '2' };

let dir: string;
let profiles: RoutingProfiles;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xvant-profile-'));
  profiles = new RoutingProfiles(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('reads routing settings from an orchestrated configuration only', () => {
  expect(settingsOf(orchestrated('haiku', 'opus'))).toEqual({
    models: { claude: 'haiku' },
    plannerModel: 'opus',
  });
  // A record says `default` when the runtime chose its own model.
  expect(
    settingsOf({
      runtime: 'xvant-orchestrated',
      workerRuntime: 'codex',
      model: 'default',
    }),
  ).toEqual({ models: {} });
  expect(settingsOf(orchestrated('default', 'opus'))).toEqual({
    models: { claude: 'default' },
    plannerModel: 'opus',
  });
  expect(settingsOf({ runtime: 'claude', workerRuntime: 'claude' })).toBeNull();
  expect(
    settingsOf({ runtime: 'xvant-orchestrated', workerRuntime: 'native' }),
  ).toBeNull();
});

it('generates candidates from tuning results, skipping the default, single workers and unfinished configurations', () => {
  const candidates = generateCandidates(
    report([10, 12]),
    HASH,
    DEFAULT.settings,
    new Date(0),
  );
  expect(candidates).toEqual([
    {
      version: 'opus-haiku-cccccccc',
      settings: { models: { claude: 'haiku' }, plannerModel: 'opus' },
      provenance: {
        reportHash: HASH,
        suiteId: 'v1',
        frozenHash: 'f'.repeat(64),
        configuration: 'opus-haiku',
        tuning: { scheduled: 12, accepted: 11 },
        generatedAt: new Date(0).toISOString(),
      },
    },
  ]);
  const unfinished = report([10, 12]);
  unfinished.configurations['opus-haiku']!.incomplete = 1;
  expect(generateCandidates(unfinished, HASH, DEFAULT.settings)).toEqual([]);
  // With nothing as the default, both orchestrated configurations qualify, best tuning result first.
  expect(
    generateCandidates(report([10, 12]), HASH, { models: {} }).map(
      (c) => c.provenance!.configuration,
    ),
  ).toEqual(['opus-haiku', 'haiku']);
});

it('a candidate changes nothing until promoted, and rollback restores the default', () => {
  expect(profiles.active()).toBeNull();
  profiles.initialize(DEFAULT);
  const [candidate] = generateCandidates(
    report([10, 12]),
    HASH,
    DEFAULT.settings,
  );
  profiles.addCandidate(candidate!);
  expect(profiles.candidates().map((c) => c.version)).toEqual([
    'opus-haiku-cccccccc',
  ]);
  expect(profiles.active()!.version).toBe('haiku-default');

  const entry = profiles.promote(
    candidate!.version,
    report([10, 12]),
    HASH,
    gate,
  );
  expect(entry).toMatchObject({
    version: 'opus-haiku-cccccccc',
    contentHash: settingsHash(candidate!.settings),
    evidence: {
      reportHash: HASH,
      baseline: 'haiku-default',
      benefits: ['more accepted held-out attempts'],
    },
  });
  expect(profiles.active()!.settings.plannerModel).toBe('opus');
  expect(profiles.rollback().version).toBe('haiku-default');
  expect(profiles.active()!.settings).toEqual(DEFAULT.settings);
});

it('refuses promotion without held-out evidence against the current default', () => {
  profiles.initialize(DEFAULT);
  const [candidate] = generateCandidates(
    report([10, 12]),
    HASH,
    DEFAULT.settings,
  );
  profiles.addCandidate(candidate!);
  const promote =
    (r: BenchmarkReport, options = gate) =>
    () =>
      profiles.promote(candidate!.version, r, HASH, options);
  // Tuning results made it a candidate; held-out results are worse.
  expect(promote(report([12, 10]))).toThrow(/accepted held-out attempts fell/);
  expect(promote(report([12, 12]))).toThrow(/no measured benefit/);
  expect(
    promote(report([10, 12]), { ...gate, safetyFixturesPassed: false }),
  ).toThrow(/safety or recovery fixtures regressed/);
  expect(promote(report([10, 12]), { ...gate, orchestration: '3' })).toThrow(
    /older orchestration behaviour/,
  );
  const fewer = report([10, 12]);
  fewer.bySplit['held-out']!['opus-haiku']!.scheduled = 4;
  expect(promote(fewer)).toThrow(/different number of held-out attempts/);
  const noBaseline = report([10, 12]);
  delete noBaseline.configurations.haiku;
  expect(promote(noBaseline)).toThrow(/current default was not benchmarked/);
  expect(() =>
    profiles.promote('missing', report([10, 12]), HASH, gate),
  ).toThrow(/PROFILE_NOT_FOUND/);
  expect(profiles.active()!.version).toBe('haiku-default');
  expect(profiles.ledger.history()).toEqual([]);
});

it('refuses a default whose file no longer matches the ledger', () => {
  profiles.initialize(DEFAULT);
  const file = join(dir, 'profiles', 'haiku-default.json');
  const edited = JSON.parse(readFileSync(file, 'utf8'));
  edited.settings.plannerModel = 'opus';
  writeFileSync(file, JSON.stringify(edited));
  expect(() => profiles.active()).toThrow(/PROFILE_HASH_MISMATCH/);
});
