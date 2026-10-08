import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../../packages/storage/src/store.ts';
import { computeLock } from '../../../packages/evaluation/src/suite.ts';
import { runBenchmark } from '../../../packages/evaluation/src/runner.ts';
import {
  ScriptedProvider,
  toolCall,
} from '../../../packages/native-agent/src/scripted.ts';
import {
  liveConfiguration,
  nativeConfiguration,
  orchestratedConfiguration,
} from './benchmark-live.ts';

const peer = fileURLToPath(
  new URL('../../../tests/fixtures/claude-live-peer.mjs', import.meta.url),
);
let root: string;
let suiteDir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-bench-live-')));
  suiteDir = join(root, 'fixtures', 'benchmarks', 'mini');
  mkdirSync(join(suiteDir, 'alpha', 'repo'), { recursive: true });
  writeFileSync(join(suiteDir, 'alpha', 'repo', 'README.md'), '# alpha\n');
  writeFileSync(
    join(suiteDir, 'alpha', 'check.mjs'),
    "import { readFileSync } from 'node:fs';\n" +
      "if (readFileSync('answer.txt', 'utf8').trim() !== 'alpha') process.exit(1);\n",
  );
  writeFileSync(
    join(suiteDir, 'suite.json'),
    JSON.stringify({
      id: 'mini',
      version: 1,
      tasks: [
        {
          id: 'alpha',
          category: 'feature',
          split: 'held-out',
          shape: 'single',
          objective:
            'Create a file named answer.txt containing the single line: alpha. Do not change anything else.',
          repo: 'alpha/repo',
          check: 'alpha/check.mjs',
          timeoutMs: 30000,
        },
      ],
    }),
  );
  writeFileSync(
    join(suiteDir, 'suite.lock.json'),
    JSON.stringify(computeLock(suiteDir)),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const run = (scenario: string) =>
  runBenchmark({
    suiteDir,
    configurations: {
      claude: liveConfiguration({
        kind: 'claude',
        runtime: {
          executable: process.execPath,
          prefixArgs: [peer, scenario],
          model: 'haiku',
        },
        stateRoot: join(root, 'state'),
      }),
    },
    repeats: 1,
    recordsPath: join(root, 'records.jsonl'),
    workRoot: join(root, 'work'),
  });

it('runs one runtime turn per attempt and lets the hidden check accept it', async () => {
  const { records } = await run('write');
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    status: 'accepted',
    checkPassed: true,
    usage: { inputTokens: null, outputTokens: null, totalTokens: 120 },
    versions: { runtime: 'claude', model: 'haiku' },
  });
}, 60000);

it('records a rate-limited turn as incomplete, not failed', async () => {
  const { records } = await run('fail');
  expect(records[0]).toMatchObject({ status: 'incomplete', checkPassed: null });
  expect(records[0]!.reason).toMatch(/^quota: QUOTA_BLOCKED/);
}, 60000);

it('runs the native loop as a configuration with unknown usage', async () => {
  let n = 0;
  const provider = new ScriptedProvider(() =>
    ++n === 1
      ? {
          toolCalls: [
            toolCall('file.apply_patch', {
              edits: [
                { path: 'answer.txt', expectedHash: null, content: 'alpha\n' },
              ],
            }),
          ],
        }
      : { text: 'Done.' },
  );
  const { records } = await runBenchmark({
    suiteDir,
    configurations: {
      native: nativeConfiguration({
        provider,
        classification: 'offline',
        stateRoot: join(root, 'state'),
      }),
    },
    repeats: 1,
    recordsPath: join(root, 'records.jsonl'),
    workRoot: join(root, 'work'),
  });
  expect(records[0]).toMatchObject({
    status: 'accepted',
    usage: { totalTokens: null },
    versions: { runtime: 'native-local', model: 'stub:scripted' },
  });
}, 60000);

it('runs XVANT orchestration and hands its combined result to the hidden check', async () => {
  const { records } = await runBenchmark({
    suiteDir,
    configurations: {
      xvant: orchestratedConfiguration({
        kind: 'claude',
        runtime: {
          executable: process.execPath,
          prefixArgs: [peer, 'write'],
          model: 'haiku',
        },
        stateRoot: join(root, 'state'),
        criteria: () => ['answer.txt holds alpha'],
      }),
    },
    repeats: 1,
    recordsPath: join(root, 'records.jsonl'),
    workRoot: join(root, 'work'),
  });
  expect(records[0]).toMatchObject({
    status: 'accepted',
    checkPassed: true,
    recovered: false,
    versions: {
      runtime: 'xvant-orchestrated',
      workerRuntime: 'claude',
      instructions: 'criteria',
    },
  });
}, 120000);

it('plans and reviews on the planner model while workers keep the runtime model', async () => {
  const { records } = await runBenchmark({
    suiteDir,
    configurations: {
      xvant: orchestratedConfiguration({
        kind: 'claude',
        runtime: {
          executable: process.execPath,
          prefixArgs: [peer, 'write'],
          model: 'haiku',
        },
        stateRoot: join(root, 'state'),
        criteria: () => ['answer.txt holds alpha'],
        plannerModel: 'opus',
      }),
    },
    repeats: 1,
    recordsPath: join(root, 'records.jsonl'),
    workRoot: join(root, 'work'),
  });
  expect(records[0]).toMatchObject({
    status: 'accepted',
    versions: { model: 'haiku', plannerModel: 'opus' },
  });
  const [attempt] = readdirSync(join(root, 'state'));
  const store = new Store(join(root, 'state', attempt!, 'state.sqlite'), {
    owner: 'test',
  });
  try {
    const turn = (taskId: string) => {
      const saved = store.providers.get(taskId);
      return [saved.worker.alias, saved.liveApproval!.model];
    };
    expect(turn('bench-plan-1')).toEqual(['claude-bench-1', 'opus']);
    expect(turn('bench-work-2')).toEqual(['claude-bench-2', 'haiku']);
    expect(turn('bench-review-3')).toEqual(['claude-bench-1', 'opus']);
  } finally {
    store.close();
  }
}, 120000);

it.each([
  ['a single worker', liveConfiguration],
  ['XVANT orchestration', orchestratedConfiguration],
])(
  'ends the campaign with no record when the runtime changed under %s',
  async (_name, configuration) => {
    const { records, stopped } = await runBenchmark({
      suiteDir,
      configurations: {
        claude: configuration({
          kind: 'claude',
          runtime: {
            executable: process.execPath,
            prefixArgs: [peer, 'write'],
            model: 'haiku',
            // The campaign recorded this version; the peer reports 2.1.285.
            version: '2.1.286',
          },
          stateRoot: join(root, 'state'),
        }),
      },
      repeats: 1,
      recordsPath: join(root, 'records.jsonl'),
      workRoot: join(root, 'work'),
    });
    expect(stopped).toMatch(/installed runtime/);
    expect(records).toEqual([]);
  },
  60000,
);
