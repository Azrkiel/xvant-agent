import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeLock,
  v1ShapeProblems,
  verifyFrozen,
  type Suite,
} from './suite.ts';
import {
  QuotaInterrupted,
  readRecords,
  runBenchmark,
  type Configuration,
} from './runner.ts';
import { evaluatePromotion, summarize } from './report.ts';

let root: string;
let suiteDir: string;
const TASKS = ['alpha', 'beta'];
function writeSuite() {
  suiteDir = join(root, 'fixtures', 'benchmarks', 'mini');
  mkdirSync(suiteDir, { recursive: true });
  for (const id of TASKS) {
    mkdirSync(join(suiteDir, id, 'repo'), { recursive: true });
    writeFileSync(join(suiteDir, id, 'repo', 'README.md'), '# ' + id + '\n');
    // The check passes only when the attempt wrote the expected answer.
    writeFileSync(
      join(suiteDir, id, 'check.mjs'),
      "import { readFileSync } from 'node:fs';\n" +
        "if (readFileSync('answer.txt', 'utf8') !== '" +
        id +
        "') process.exit(1);\n",
    );
  }
  writeFileSync(
    join(suiteDir, 'suite.json'),
    JSON.stringify({
      id: 'mini',
      version: 1,
      tasks: TASKS.map((id, i) => ({
        id,
        category: 'feature',
        split: i ? 'held-out' : 'tuning',
        shape: 'single',
        objective: 'Write ' + id + ' to answer.txt',
        repo: id + '/repo',
        check: id + '/check.mjs',
        timeoutMs: 20000,
      })),
    }),
  );
}
const freeze = () =>
  writeFileSync(
    join(suiteDir, 'suite.lock.json'),
    JSON.stringify(computeLock(suiteDir)),
  );
const solver = (
  answer: (task: string) => string | null,
  extra: Partial<Awaited<ReturnType<Configuration['run']>>> = {},
): Configuration => ({
  versions: { runtime: 'test' },
  async run({ task, workspace }) {
    const text = answer(task.id);
    if (text !== null) writeFileSync(join(workspace, 'answer.txt'), text);
    return { outcome: 'finished', ...extra };
  },
});
const right = solver((task) => task, {
  usage: { inputTokens: 10, outputTokens: 5 },
});
const wrong = solver(() => 'nope');
const campaign = (
  configurations: Record<string, Configuration>,
  repeats = 1,
  extra: Partial<Parameters<typeof runBenchmark>[0]> = {},
) =>
  runBenchmark({
    suiteDir,
    configurations,
    repeats,
    recordsPath: join(root, 'records.jsonl'),
    workRoot: join(root, 'work'),
    ...extra,
  });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-eval-')));
  writeSuite();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('frozen suite', () => {
  it('refuses to run a suite that was never frozen', async () => {
    expect(() => verifyFrozen(suiteDir)).toThrow('SUITE_NOT_FROZEN');
    await expect(campaign({ right })).rejects.toThrow('SUITE_NOT_FROZEN');
  });
  it.each([
    ['an acceptance check', () => join(suiteDir, 'alpha', 'check.mjs')],
    ['a starting repository', () => join(suiteDir, 'alpha', 'repo', 'x.txt')],
  ])('refuses to run after %s changes', async (_name, path) => {
    freeze();
    appendFileSync(path(), '// easier\n');
    await expect(campaign({ right })).rejects.toThrow(
      'SUITE_CHANGED_AFTER_FREEZE: alpha',
    );
    expect(existsSync(join(root, 'records.jsonl'))).toBe(false);
  });
  it('refuses to run after a task definition changes', () => {
    freeze();
    const suite = JSON.parse(
      readFileSync(join(suiteDir, 'suite.json'), 'utf8'),
    ) as Suite;
    suite.tasks[1]!.objective = 'Write anything';
    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify(suite));
    expect(() => verifyFrozen(suiteDir)).toThrow(
      'SUITE_CHANGED_AFTER_FREEZE: beta',
    );
  });
  it('rejects paths that leave the fixtures root', () => {
    const suite = JSON.parse(
      readFileSync(join(suiteDir, 'suite.json'), 'utf8'),
    ) as Suite;
    suite.tasks[0]!.check = '../../../outside.mjs';
    writeFileSync(join(suiteDir, 'suite.json'), JSON.stringify(suite));
    expect(() => computeLock(suiteDir)).toThrow('SUITE_PATH_ESCAPE');
  });
  it('names what a suite lacks to be the v1 benchmark', () => {
    freeze();
    const problems = v1ShapeProblems(verifyFrozen(suiteDir).suite);
    expect(problems).toContain('needs 24 tasks, has 2');
    expect(problems).toContain('debugging needs 6 tasks, has 0');
    expect(problems).toContain('needs at least 4 parallel tasks');
  });
});

describe('campaign', () => {
  beforeEach(freeze);
  it('lets only the hidden host check decide acceptance', async () => {
    const seen: string[] = [];
    const { records } = await campaign({
      right,
      wrong,
      peeks: {
        versions: {},
        async run({ workspace }) {
          seen.push(String(existsSync(join(workspace, 'check.mjs'))));
          return { outcome: 'finished' };
        },
      },
    });
    const status = (configuration: string) =>
      records
        .filter((r) => r.configuration === configuration)
        .map((r) => r.status);
    expect(status('right')).toEqual(['accepted', 'accepted']);
    expect(status('wrong')).toEqual(['failed', 'failed']);
    expect(status('peeks')).toEqual(['failed', 'failed']);
    expect(seen).toEqual(['false', 'false']);
  }, 60000);
  it('keeps quota-interrupted attempts incomplete and does not retry them', async () => {
    let calls = 0;
    const limited: Configuration = {
      versions: {},
      async run() {
        calls += 1;
        throw new QuotaInterrupted('weekly limit');
      },
    };
    const first = await campaign({ limited });
    const second = await campaign({ limited });
    expect(calls).toBe(2);
    expect(second.records.map((r) => r.status)).toEqual([
      'incomplete',
      'incomplete',
    ]);
    const report = summarize(
      verifyFrozen(suiteDir).suite,
      first.records[0]!.frozenHash,
      second.schedule,
      second.records,
    );
    expect(report.complete).toBe(false);
    expect(report.configurations.limited!.successRate).toBe(0);
  }, 60000);
  it('resumes a stopped campaign without rerunning recorded attempts', async () => {
    const stop = new AbortController();
    let runs = 0;
    const counting: Configuration = {
      versions: {},
      async run(input) {
        runs += 1;
        stop.abort();
        return right.run(input);
      },
    };
    const first = await campaign({ counting }, 2, { signal: stop.signal });
    expect(first.records).toHaveLength(1);
    const report = summarize(
      verifyFrozen(suiteDir).suite,
      first.records[0]!.frozenHash,
      first.schedule,
      first.records,
    );
    expect(report.complete).toBe(false);
    expect(report.missing).toHaveLength(3);
    expect(report.configurations.counting!.successRate).toBe(0.25);
    const second = await campaign({ counting }, 2);
    expect(second.records).toHaveLength(4);
    expect(runs).toBe(4);
  }, 60000);
  it('records failures, give-ups, errors and declared exclusions', async () => {
    const { schedule, records } = await campaign(
      {
        quits: {
          versions: {},
          run: async () => ({ outcome: 'gave_up', reason: 'too hard' }),
        },
        throws: {
          versions: {},
          run: async () => {
            throw new Error('boom');
          },
        },
        right,
      },
      1,
      {
        exclusions: [
          {
            taskId: 'beta',
            configuration: 'right',
            repeat: 1,
            reason: 'needs a network',
          },
        ],
      },
    );
    expect(records).toHaveLength(schedule.length);
    const of = (configuration: string) =>
      records.filter((r) => r.configuration === configuration);
    expect(of('quits').map((r) => [r.status, r.reason, r.checkPassed])).toEqual(
      [
        ['failed', 'too hard', null],
        ['failed', 'too hard', null],
      ],
    );
    expect(of('throws')[0]!.reason).toBe('configuration error: boom');
    expect(of('right').map((r) => r.status)).toEqual(['accepted', 'excluded']);
    const report = summarize(
      verifyFrozen(suiteDir).suite,
      records[0]!.frozenHash,
      schedule,
      records,
    );
    expect(report.exclusions).toEqual([
      { taskId: 'beta', configuration: 'right', reason: 'needs a network' },
    ]);
    expect(report.configurations.right).toMatchObject({
      accepted: 1,
      excluded: 1,
      successRate: 1,
    });
    expect(readRecords(join(root, 'records.jsonl'))).toEqual(records);
  }, 60000);
  it('rejects records from a different freeze', async () => {
    await campaign({ right });
    writeFileSync(join(suiteDir, 'alpha', 'repo', 'new.txt'), 'x');
    freeze();
    await expect(campaign({ right })).rejects.toThrow(
      'RECORDS_FROM_ANOTHER_FREEZE',
    );
  }, 60000);
});

describe('report and promotion', () => {
  beforeEach(freeze);
  const run = async (configurations: Record<string, Configuration>) => {
    const { schedule, records } = await campaign(configurations, 2);
    return summarize(
      verifyFrozen(suiteDir).suite,
      records[0]!.frozenHash,
      schedule,
      records,
    );
  };
  it('does not invent usage and labels small samples', async () => {
    const report = await run({ right, wrong });
    expect(report.configurations.right).toMatchObject({
      accepted: 4,
      tasksAlwaysAccepted: 2,
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(report.configurations.wrong).toMatchObject({
      accepted: 0,
      failed: 4,
      successRate: 0,
      inputTokens: null,
      outputTokens: null,
    });
    expect(report.directional).toBe(true);
    expect(report.limitations.join(' ')).toMatch(/directional/);
    expect(report.limitations.join(' ')).toMatch(/not estimated/);
    expect(report.bySplit['held-out']!.right).toEqual({
      scheduled: 2,
      accepted: 2,
    });
  }, 60000);
  it('blocks a candidate that accepts fewer held-out tasks, whatever else improves', async () => {
    const cheaper = solver((task) => (task === 'beta' ? 'nope' : task), {
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const report = await run({ right, cheaper });
    const verdict = evaluatePromotion(report, {
      baseline: 'right',
      candidate: 'cheaper',
      safetyFixturesPassed: true,
    });
    expect(verdict.promote).toBe(false);
    expect(verdict.benefits).toContain('lower measured token usage');
    expect(verdict.blockers).toEqual([
      'accepted held-out attempts fell from 2 to 0',
    ]);
  }, 60000);
  it('promotes only with a measured benefit and passing safety fixtures', async () => {
    const lean = solver((task) => task, {
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const report = await run({ right, lean, same: right });
    const options = { baseline: 'right', safetyFixturesPassed: true };
    expect(
      evaluatePromotion(report, { ...options, candidate: 'lean' }),
    ).toMatchObject({ promote: true, blockers: [] });
    expect(
      evaluatePromotion(report, {
        ...options,
        candidate: 'lean',
        safetyFixturesPassed: false,
      }).blockers,
    ).toEqual(['safety or recovery fixtures regressed']);
    expect(
      evaluatePromotion(report, { ...options, candidate: 'missing' }).promote,
    ).toBe(false);
  }, 60000);
});
