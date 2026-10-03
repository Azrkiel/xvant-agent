import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suitePath, verifyFrozen } from './suite.ts';
import { runBenchmark } from './runner.ts';
import { summarize } from './report.ts';
import { noopConfiguration, referenceConfiguration } from './reference.ts';

const suiteDir = fileURLToPath(
  new URL('../../../fixtures/benchmarks/smoke', import.meta.url),
);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-smoke-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('the committed smoke suite is frozen and separates a solution from no change', async () => {
  const { suite, lock } = verifyFrozen(suiteDir);
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
  expect(report.complete).toBe(true);
  expect(report.configurations.reference).toMatchObject({
    accepted: 10,
    failed: 0,
  });
  expect(report.configurations.noop).toMatchObject({ accepted: 0, failed: 10 });
}, 120000);
