import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import {
  ScriptedProvider,
  lastResult,
  toolCall,
  type Script,
} from '../../../packages/native-agent/src/scripted.ts';
import { ModelError } from '../../../packages/native-agent/src/model.ts';
import { Orchestrator, type WorkerSpec } from './orchestrator.ts';
import { NativeTurnRunner } from './native-turn-runner.ts';
import { LiveTurnRunner } from './turn-runner.ts';

vi.setConfig({ testTimeout: 60000 });
let root: string, repo: string, store: Store, objects: ArtifactStore;
let baseCommit: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: repo,
  })
    .toString()
    .trim();
const open = () => new Store(join(root, 'state.sqlite'), { owner: 'test' });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-native-turns-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  baseCommit = git('rev-parse', 'HEAD');
  store = open();
  objects = new ArtifactStore(join(root, 'objects'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const workers: WorkerSpec[] = [
  {
    alias: 'native-1',
    runtimeKind: 'native-local',
    quotaGroupId: 'local-gpu',
    roles: ['worker'],
  },
];
const fileCheck = (name: string, exit = 0) => ({
  [name]: {
    executable: process.execPath,
    args: [
      '-e',
      exit
        ? "console.error('expected greeting, found none'); process.exit(" +
          exit +
          ')'
        : "require('node:fs').readFileSync('" + name + ".txt')",
    ],
  },
});
const writes =
  (path: string, content: string): Script =>
  (messages, n) =>
    n === 1
      ? {
          toolCalls: [
            toolCall('file.apply_patch', {
              edits: [{ path, expectedHash: null, content }],
            }),
          ],
        }
      : lastResult(messages).status === 'succeeded'
        ? { text: 'Wrote ' + path }
        : { text: 'Could not write ' + path };
const runner = (script: Script, extra = {}) =>
  new NativeTurnRunner(store, objects, workers, new ScriptedProvider(script), {
    classification: 'offline',
    checkTimeoutMs: 20000,
    ...extra,
  });
const turn = (r: NativeTurnRunner, extra = {}) =>
  r.run({
    taskId: 'node-a',
    projectId: 'p',
    alias: 'native-1',
    prompt: 'Create a.txt',
    workspace: { path: repo, baseCommit },
    checks: fileCheck('a'),
    ...extra,
  });

it('runs a node through the native loop, host-verifies and accepts it as native-local', async () => {
  const stateDir = join(root, 'checkpoints');
  const outcome = await turn(runner(writes('a.txt', 'a ok\n'), { stateDir }));
  expect(outcome).toMatchObject({
    status: 'accepted',
    finalText: 'Wrote a.txt',
    files: ['a.txt'],
  });
  expect(outcome.patch!.toString()).toContain('+a ok');
  expect(store.getTask('node-a').state).toBe('accepted');
  const connection = store.providers.get('node-a');
  expect(connection.worker).toMatchObject({
    runtimeKind: 'native-local',
    adapterVersion: 'xvant-native-v1',
  });
  expect(connection.classification).toBe('offline');
  expect(readdirSync(stateDir)).toEqual(['node-a.checkpoint.json']);
});

it('journals every tool receipt so they survive a restart', async () => {
  await turn(runner(writes('a.txt', 'a ok\n')));
  store.close();
  store = open();
  const receipts = store
    .events(0, 1000)
    .filter((e) => e.kind === 'tool.receipt')
    .map((e) => e.payload as Record<string, unknown>);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    connectionId: 'node-a',
    tool: 'file.apply_patch',
    status: 'succeeded',
    workerId: 'native-1',
    attemptId: 'node-a-a1',
  });
});

it('enforces node write ownership through the tools, not the prompt', async () => {
  const outcome = await turn(
    runner((messages, n) =>
      n === 1
        ? {
            toolCalls: [
              toolCall('file.apply_patch', {
                edits: [{ path: 'b.txt', expectedHash: null, content: 'x' }],
              }),
            ],
          }
        : n === 2
          ? {
              toolCalls: [
                toolCall('file.apply_patch', {
                  edits: [
                    { path: 'a.txt', expectedHash: null, content: 'a\n' },
                  ],
                }),
              ],
            }
          : { text: 'done: ' + lastResult(messages).status },
    ),
    { writablePaths: ['a.txt'] },
  );
  expect(outcome.status).toBe('accepted');
  expect(outcome.files).toEqual(['a.txt']);
  expect(existsSync(join(repo, 'b.txt'))).toBe(false);
  const codes = store
    .events(0, 1000)
    .filter((e) => e.kind === 'tool.receipt')
    .map((e) => (e.payload as { code?: string }).code ?? 'ok');
  expect(codes).toEqual(['PATH_DENIED', 'ok']);
});

it('reports failing checks with their output for the repair', async () => {
  const outcome = await turn(runner(writes('a.txt', 'a\n')), {
    checks: fileCheck('greeting', 1),
  });
  expect(outcome.status).toBe('verification_failed');
  expect(outcome.failure).toContain('Checks failed: greeting');
  expect(outcome.failure).toContain('expected greeting, found none');
});

it('records a loop that hits its step cap as a known failure', async () => {
  const outcome = await turn(
    runner(
      () => ({ toolCalls: [toolCall('file.read', { path: 'README.md' })] }),
      {
        limits: { maxSteps: 3 },
      },
    ),
  );
  expect(outcome).toMatchObject({
    status: 'failed',
    failure: 'WORKER_FAILED:step_limit',
  });
  expect(store.getTask('node-a').state).not.toBe('accepted');
});

it('maps an unavailable model to MODEL_UNAVAILABLE and other faults to WORKER_FAILED', async () => {
  const failing = (error: Error) =>
    new NativeTurnRunner(
      store,
      objects,
      workers,
      new ScriptedProvider(() => {
        throw error;
      }),
      { classification: 'offline' },
    );
  expect(
    await turn(failing(new ModelError('MODEL_UNAVAILABLE', 'not loaded'))),
  ).toMatchObject({
    status: 'failed',
    failure: 'MODEL_UNAVAILABLE:model_unavailable',
  });
  expect(
    await turn(failing(new Error('bug')), { taskId: 'node-b' }),
  ).toMatchObject({ status: 'failed', failure: 'WORKER_FAILED:model_failed' });
});

it('stops on interrupt and records a cancelled turn', async () => {
  let r: NativeTurnRunner;
  const pending = turn(
    (r = runner(async () => {
      r.interrupt('node-a');
      return { toolCalls: [toolCall('file.read', { path: 'README.md' })] };
    })),
  );
  const outcome = await pending;
  expect(outcome.status).toBe('cancelled');
  expect(r.interrupt('node-a')).toBe(false);
});

it('admits a live dispatch only as an explicit model over loopback HTTP', async () => {
  await turn(runner(writes('a.txt', 'a ok\n'), { classification: 'live' }));
  const connection = store.providers.get('node-a');
  expect(connection.classification).toBe('live');
  expect(connection.liveApproval).toMatchObject({
    transport: 'loopback-http',
    model: 'scripted',
    profile: 'workspace-write',
  });
  expect(connection.liveApproval!.acknowledgedNativeBypass).toBeUndefined();
});

it('runs native-local nodes inside an orchestrated root through the live runner', async () => {
  const native = runner(writes('a.txt', 'a ok\n'));
  const live = new LiveTurnRunner(store, objects, workers, {}, { native });
  const state = await new Orchestrator(store, live, workers, {
    stateRoot: join(root, 'runs'),
  }).run({
    id: 'app',
    projectId: 'p',
    repository: repo,
    baseRevision: 'main',
    objective: 'Create a.txt',
    acceptanceCriteria: ['a.txt exists'],
    checks: fileCheck('a'),
    review: false,
    plan: {
      summary: 'one file',
      nodes: [
        {
          id: 'a',
          title: 'a',
          objective: 'Create a.txt',
          acceptanceCriteria: ['a.txt exists'],
          assignee: 'native-local',
          writablePaths: ['a.txt'],
        },
      ],
    },
  });
  expect(state.reason).toBeUndefined();
  expect(state.phase).toBe('ready');
  // Git may check the integration branch out with CRLF line endings.
  expect(readFileSync(join(state.integration!.path, 'a.txt'), 'utf8')).toMatch(
    /^a ok\r?\n$/,
  );
  // The user's checkout is untouched.
  expect(existsSync(join(repo, 'a.txt'))).toBe(false);
  await expect(
    new LiveTurnRunner(store, objects, workers, {}).run({
      taskId: 'x',
      projectId: 'p',
      alias: 'native-1',
      prompt: 'x',
      workspace: { path: repo, baseCommit },
      checks: {},
    }),
  ).rejects.toThrow('RUNTIME_UNAVAILABLE');
});

it('accepts a turn in a store that already holds more than one page of events', async () => {
  const reads = Array.from({ length: 8 }, () =>
    toolCall('file.read', { path: 'README.md' }),
  );
  const outcome = await turn(
    runner(
      (messages, n) =>
        n <= 15
          ? { toolCalls: reads }
          : n === 16
            ? {
                toolCalls: [
                  toolCall('file.apply_patch', {
                    edits: [
                      { path: 'a.txt', expectedHash: null, content: 'a\n' },
                    ],
                  }),
                ],
              }
            : { text: 'done ' + messages.length },
      { limits: { maxSteps: 20, maxContextChars: 400_000 } },
    ),
  );
  expect(store.events(0, 1000).length).toBeGreaterThan(120);
  expect(outcome.status).toBe('accepted');
});
