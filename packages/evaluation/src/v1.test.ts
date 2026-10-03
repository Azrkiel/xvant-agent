import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suitePath, v1ShapeProblems, verifyFrozen } from './suite.ts';
import { runBenchmark } from './runner.ts';
import { summarize } from './report.ts';
import { noopConfiguration, referenceConfiguration } from './reference.ts';

const suiteDir = fileURLToPath(
  new URL('../../../fixtures/benchmarks/v1', import.meta.url),
);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-v1-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('the v1 suite is frozen, has the planned shape, and every check separates its solution from no change', async () => {
  const { suite, lock } = verifyFrozen(suiteDir);
  expect(v1ShapeProblems(suite)).toEqual([]);
  expect(suite.tasks.every((t) => t.acceptanceCriteria?.length)).toBe(true);
  const { schedule, records } = await runBenchmark({
    suiteDir,
    configurations: {
      reference: referenceConfiguration((taskId) =>
        join(
          dirname(
            suitePath(
              suiteDir,
              suite.tasks.find((t) => t.id === taskId)!.check,
            ),
          ),
          'solution.json',
        ),
      ),
      noop: noopConfiguration,
    },
    repeats: 1,
    recordsPath: join(root, 'records.jsonl'),
    workRoot: join(root, 'work'),
  });
  const report = summarize(suite, lock.frozenHash, schedule, records);
  expect(report.configurations.reference).toMatchObject({
    accepted: 24,
    failed: 0,
  });
  expect(report.configurations.noop).toMatchObject({ accepted: 0, failed: 24 });
  expect(report.bySplit['held-out']!.reference!.scheduled).toBe(12);
}, 300000);
