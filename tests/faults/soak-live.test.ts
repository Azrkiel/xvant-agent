import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validatePlan } from '../../packages/core/src/plan.ts';
import { seeded, type Findings } from '../../scripts/soak-run.ts';
import {
  LIVE_SCENARIOS,
  buildLiveScenario,
  descendantsOf,
  leakedProcesses,
  liveInspect,
  liveReceipt,
  parseProcessList,
  processKey,
  scenarioPicker,
  summarizeOutcomes,
  type LiveScenario,
  type ProcessRow,
} from '../../scripts/soak-live.ts';

// Nothing here starts a model turn; the checks are run against files written
// by the test, in place of what a worker would write.
const temp = mkdtempSync(join(tmpdir(), 'xvant-soak-live-test-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe('scenario selection', () => {
  it('covers every scenario before repeating, and is seeded', () => {
    const draw = (seed: number, n: number) => {
      const pick = scenarioPicker(seeded(seed));
      return Array.from({ length: n }, pick);
    };
    expect([...draw(20261008, 5)].sort()).toEqual([...LIVE_SCENARIOS].sort());
    expect([...draw(3, 10).slice(5)].sort()).toEqual(
      [...LIVE_SCENARIOS].sort(),
    );
    expect(draw(20261008, 8)).toEqual(draw(20261008, 8));
    expect(draw(1, 10)).not.toEqual(draw(2, 10));
  });
});

const prepare = (scenario: LiveScenario) => {
  const dir = mkdtempSync(join(temp, scenario + '-'));
  const checks = join(dir, 'checks');
  const repo = join(dir, 'repo');
  mkdirSync(checks);
  mkdirSync(repo);
  const spec = buildLiveScenario(scenario, checks, process.execPath);
  for (const [file, text] of Object.entries(spec.files))
    writeFileSync(join(repo, file), text);
  for (const [file, text] of Object.entries(spec.checkFiles))
    writeFileSync(join(checks, file), text);
  // The registered command, run the way the orchestrator runs it.
  const run = async () => {
    const { shellCheck } = await import('../../apps/controller/src/app.ts');
    const c = shellCheck(spec.command);
    return spawnSync(c.executable, c.args, {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      ...('windowsVerbatimArguments' in c
        ? { windowsVerbatimArguments: true }
        : {}),
    });
  };
  const write = (file: string, text: string) =>
    writeFileSync(join(repo, file), text);
  return { spec, run, write, repo };
};

describe('live scenarios', () => {
  it.each(LIVE_SCENARIOS)('%s has a valid plan and a plain repository', (s) => {
    const { spec } = prepare(s);
    expect(() => validatePlan(spec.plan)).not.toThrow();
    for (const file of Object.keys(spec.files)) expect(file).toMatch(/\.js$/);
    expect(Object.keys(spec.files).length).toBeGreaterThanOrEqual(3);
    expect(spec.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(spec.phases.length).toBeGreaterThan(0);
  });

  it('clean: the check fails without the work and passes with it', async () => {
    const { run, write } = prepare('clean');
    expect((await run()).status).not.toBe(0);
    write('shout.js', "module.exports = (t) => t.toUpperCase() + '!';\n");
    expect((await run()).status).toBe(0);
  });

  it('check_fails_first: the check names a file the objective does not', async () => {
    const { spec, run, write } = prepare('check_fails_first');
    const mentioned = [spec.objective, ...spec.acceptanceCriteria].join(' ');
    expect(mentioned).not.toMatch(/VERSION/);
    write('add.js', 'module.exports = (a, b) => a + b;\n');
    const failed = await run();
    expect(failed.status).toBe(1);
    expect(failed.stdout + failed.stderr).toMatch(/VERSION\.txt/);
    write('VERSION.txt', '1.0.0\n');
    expect((await run()).status).toBe(0);
  });

  it('impossible_check: exits 1 whatever the repository holds', async () => {
    const { spec, run, write } = prepare('impossible_check');
    expect(spec.command).toContain('process.exit(1)');
    expect((await run()).status).toBe(1);
    write('double.js', 'module.exports = (n) => n * 2;\n');
    expect((await run()).status).toBe(1);
  });

  it('cancel_mid_run: a valid check for a single node', async () => {
    const { spec, run, write } = prepare('cancel_mid_run');
    expect(spec.plan.nodes).toHaveLength(1);
    write(
      'stats.js',
      'exports.mean = (l) => l.reduce((a, b) => a + b, 0) / l.length;\nexports.median = () => 0;\nexports.mode = () => 0;\n',
    );
    expect((await run()).status).toBe(0);
  });

  it('conflicting_nodes: parallel nodes that rewrite one shared line', async () => {
    const { spec, run, write } = prepare('conflicting_nodes');
    expect(spec.plan.nodes).toHaveLength(2);
    expect(spec.maxActive).toBe(2);
    expect(spec.plan.nodes.every((n) => n.dependsOn.length === 0)).toBe(true);
    for (const n of spec.plan.nodes)
      expect(n.objective).toContain('registry.js');
    write('feature-a.js', "module.exports = 'a';\n");
    write('feature-b.js', "module.exports = 'b';\n");
    write('registry.js', "module.exports = { last: 'b' };\n");
    expect((await run()).status).toBe(0);
    write('registry.js', "module.exports = { last: 'none' };\n");
    expect((await run()).status).toBe(1);
  });
});

const row = (
  pid: number,
  ppid: number,
  created: number,
  name = 'p' + pid,
): ProcessRow => ({ pid, ppid, created, name });

describe('process tracking', () => {
  it('parses the process list', () => {
    expect(
      parseProcessList(
        '4 0 100 System\r\n250 4 200 claude.exe\nnot a row\n7 4 300 My Program.exe\n',
      ),
    ).toEqual([
      row(4, 0, 100, 'System'),
      row(250, 4, 200, 'claude.exe'),
      row(7, 4, 300, 'My Program.exe'),
    ]);
  });

  it('finds descendants, not unrelated or pid-reused processes', () => {
    const rows = [
      row(1, 0, 10),
      row(100, 1, 20),
      row(101, 100, 30),
      row(102, 101, 40),
      row(200, 1, 20),
      // Parent pid 100 reused: this one is older than the process holding it now.
      row(300, 100, 5),
    ];
    expect(descendantsOf(rows, 100).map((r) => r.pid)).toEqual([101, 102]);
    expect(descendantsOf(rows, 100, new Set([200])).map((r) => r.pid)).toEqual([
      101, 102,
    ]);
  });

  it('reports a live child and an orphan seen earlier, and ignores the sampler', () => {
    const root = 100;
    const child = row(101, root, 30, 'claude.exe');
    const orphan = row(102, 999, 40, 'node.exe');
    const seen = new Map([
      [processKey(child), child],
      [processKey(orphan), orphan],
    ]);
    const rows = [
      row(root, 1, 20),
      child,
      orphan,
      row(500, root, 50, 'powershell.exe'),
      row(501, 500, 51, 'conhost.exe'),
    ];
    const leaked = leakedProcesses(seen, rows, root, 500, new Set());
    expect(leaked.map((r) => r.pid).sort()).toEqual([101, 102]);
    // Gone, or ignored from the baseline: nothing leaks.
    expect(
      leakedProcesses(seen, [row(root, 1, 20)], root, null, new Set()),
    ).toEqual([]);
    expect(
      leakedProcesses(
        seen,
        rows,
        root,
        500,
        new Set([processKey(child), processKey(orphan)]),
      ),
    ).toEqual([]);
    // A reused pid is a different process.
    expect(
      leakedProcesses(
        seen,
        [row(root, 1, 20), row(101, 1, 999)],
        root,
        null,
        new Set(),
      ),
    ).toEqual([]);
  });
});

const findings = (): Findings => ({ problems: [], notes: [], faults: {} });
const state = (phase: string, status = 'passed') => ({
  phase,
  checks: [{ id: 'check', status }],
});
const checked = (status: string) => ({
  kind: 'graph.checked',
  payload: { checks: [{ id: 'check', status }] },
});

describe('live scenario expectations', () => {
  const noCancel = { cancelDelivered: false, cancelAt: undefined };
  it('records how a failing first check ended', () => {
    const repaired = findings();
    liveInspect(
      'check_fails_first',
      state('ready'),
      [
        checked('failed'),
        { kind: 'graph.fix', payload: {} },
        checked('passed'),
      ],
      [],
      repaired,
      noCancel,
    );
    expect(repaired.notes).toEqual(['repaired by a fix turn']);
    const unfixed = findings();
    liveInspect(
      'check_fails_first',
      state('failed', 'failed'),
      [checked('failed')],
      [],
      unfixed,
      noCancel,
    );
    expect(unfixed.notes).toEqual(['repair budget ran out']);
    expect(unfixed.problems).toEqual([]);
    const lucky = findings();
    liveInspect(
      'check_fails_first',
      state('ready'),
      [checked('passed')],
      [],
      lucky,
      noCancel,
    );
    expect(lucky.notes[0]).toMatch(/fault was not exercised/);
  });

  it('flags an impossible check that was ready, and ready without a pass', () => {
    const bad = findings();
    liveInspect(
      'impossible_check',
      state('ready'),
      [checked('passed')],
      [],
      bad,
      noCancel,
    );
    expect(bad.problems).toHaveLength(1);
    const unverified = findings();
    liveInspect(
      'clean',
      state('ready', 'failed'),
      [],
      [],
      unverified,
      noCancel,
    );
    expect(unverified.problems).toEqual(['ready without a passing check']);
  });

  it('counts a delivered cancel and a conflict', () => {
    const cancelled = findings();
    liveInspect('cancel_mid_run', state('cancelled'), [], [], cancelled, {
      cancelDelivered: true,
      cancelAt: 1,
    });
    expect(cancelled.faults.cancel_delivered).toBe(1);
    const conflict = findings();
    liveInspect(
      'conflicting_nodes',
      state('ready'),
      [
        {
          kind: 'node.repair',
          payload: { reason: 'Integration conflict in registry.js' },
        },
      ],
      [],
      conflict,
      noCancel,
    );
    expect(conflict.notes).toEqual(['integration conflict observed']);
    const avoided = findings();
    liveInspect('conflicting_nodes', state('ready'), [], [], avoided, noCancel);
    expect(avoided.notes[0]).toMatch(/avoided/);
  });
});

describe('receipt assembly', () => {
  const outcome = (
    iteration: number,
    scenario: string,
    phase: string | null,
    notes: string[],
    violations: string[] = [],
  ) => ({
    iteration,
    scenario,
    phase,
    reason: null,
    durationMs: 1000,
    notes,
    violations,
  });
  const outcomes = [
    outcome(0, 'clean', 'ready', []),
    outcome(1, 'clean', 'ready', []),
    outcome(2, 'check_fails_first', 'ready', ['repaired by a fix turn']),
    outcome(3, 'impossible_check', 'ready', [], ['phase ready']),
  ];
  it('summarizes per scenario', () => {
    expect(summarizeOutcomes(outcomes)).toEqual({
      clean: { runs: 2, phases: { ready: 2 }, observed: {}, violations: 0 },
      check_fails_first: {
        runs: 1,
        phases: { ready: 1 },
        observed: { 'repaired by a fix turn': 1 },
        violations: 0,
      },
      impossible_check: {
        runs: 1,
        phases: { ready: 1 },
        observed: {},
        violations: 1,
      },
    });
  });
  const base = {
    seed: 1,
    requestedMinutes: 12,
    durationMs: 1,
    iterations: 4,
    scenarioCounts: {},
    faultCounts: {},
    phaseCounts: {},
    memory: {} as never,
    maxTimerGapMs: 0,
    violations: ['iteration 3 (impossible_check): phase ready'],
    outcomes,
  };
  const meta = {
    minutes: 12,
    maxIterations: 8,
    model: 'haiku',
    runtime: { executable: 'claude.exe', version: '2.1.0' },
  };
  it('is classified live and carries the violations as problems', () => {
    const receipt = liveReceipt(base, meta);
    expect(receipt.classification).toBe('live');
    expect(receipt.model).toBe('haiku');
    expect(receipt.runtime.version).toBe('2.1.0');
    expect(receipt.problems).toEqual(base.violations);
    expect(receipt.scenarios.clean?.runs).toBe(2);
  });
  it('fails a run that did nothing', () => {
    expect(
      liveReceipt({ ...base, iterations: 0, violations: [] }, meta).problems,
    ).toEqual(['No iteration ran']);
  });
});
