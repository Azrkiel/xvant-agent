import { afterAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, loadSuite, suitePath, verifyFrozen } from './suite.ts';
import { runBenchmark, type Configuration } from './runner.ts';
import { summarize } from './report.ts';
import { noopConfiguration, referenceConfiguration } from './reference.ts';

const fixtures = new URL('../../../fixtures/benchmarks/', import.meta.url);
const suiteDir = fileURLToPath(new URL('v2', fixtures));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-v2-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const solutionPath = (taskId: string) => {
  const { tasks } = loadSuite(suiteDir);
  const task = tasks.find((t) => t.id === taskId)!;
  return join(dirname(suitePath(suiteDir, task.check)), 'solution.json');
};

it('the v2 suite is frozen and has the planned shape', () => {
  const { suite } = verifyFrozen(suiteDir);
  expect(suite.id).toBe('v2');
  expect(suite.tasks).toHaveLength(8);
  for (const category of CATEGORIES) {
    expect(suite.tasks.filter((t) => t.category === category)).toHaveLength(2);
    for (const split of ['tuning', 'held-out'] as const)
      expect(
        suite.tasks.filter((t) => t.category === category && t.split === split),
      ).toHaveLength(1);
  }
  expect(suite.tasks.filter((t) => t.split === 'tuning')).toHaveLength(4);
  expect(suite.tasks.filter((t) => t.split === 'held-out')).toHaveLength(4);
  expect(
    suite.tasks.filter((t) => t.shape === 'parallel').length,
  ).toBeGreaterThanOrEqual(6);
  expect(suite.tasks.every((t) => t.timeoutMs === 1_800_000)).toBe(true);
  expect(suite.tasks.every((t) => t.acceptanceCriteria?.length)).toBe(true);
  expect(suite.tasks.every((t) => t.visibleTests?.length)).toBe(true);
  const v1 = loadSuite(fileURLToPath(new URL('v1', fixtures)));
  const taken = new Set(v1.tasks.map((t) => t.id));
  expect(suite.tasks.filter((t) => taken.has(t.id))).toEqual([]);
});

it('every reference solution changes at least four files', () => {
  for (const task of loadSuite(suiteDir).tasks) {
    const { edits } = JSON.parse(
      readFileSync(solutionPath(task.id), 'utf8'),
    ) as { edits: { path: string }[] };
    expect(
      new Set(edits.map((e) => e.path)).size,
      task.id,
    ).toBeGreaterThanOrEqual(4);
  }
});

it('every check separates its solution from no change, and every visible test fails before the solution and passes after it', async () => {
  const { suite, lock } = verifyFrozen(suiteDir);
  const reference = referenceConfiguration(solutionPath);
  const visible: Record<string, { before: boolean[]; after: boolean[] }> = {};
  const runVisible = (workspace: string, tests: string[]) =>
    tests.map(
      (test) =>
        spawnSync(process.execPath, [test], {
          cwd: workspace,
          timeout: 60_000,
          windowsHide: true,
        }).status === 0,
    );
  const checked: Configuration = {
    versions: reference.versions,
    async run(input) {
      const tests = input.task.visibleTests ?? [];
      const before = runVisible(input.workspace, tests);
      const result = await reference.run(input);
      visible[input.task.id] = {
        before,
        after: runVisible(input.workspace, tests),
      };
      return result;
    },
  };
  const { schedule, records } = await runBenchmark({
    suiteDir,
    configurations: { reference: checked, noop: noopConfiguration },
    repeats: 1,
    recordsPath: join(root, 'records.jsonl'),
    workRoot: join(root, 'work'),
  });
  const report = summarize(suite, lock.frozenHash, schedule, records);
  expect(report.configurations.reference).toMatchObject({
    accepted: 8,
    failed: 0,
  });
  expect(report.configurations.noop).toMatchObject({ accepted: 0, failed: 8 });
  expect(report.bySplit['held-out']!.reference!.scheduled).toBe(4);
  for (const task of suite.tasks) {
    const { before, after } = visible[task.id]!;
    expect(before, task.id + ' visible tests before').toEqual(
      before.map(() => false),
    );
    expect(after, task.id + ' visible tests after').toEqual(
      after.map(() => true),
    );
    expect(after).toHaveLength(task.visibleTests!.length);
  }
}, 900000);
