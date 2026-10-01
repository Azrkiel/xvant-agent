import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { writeChunked } from '../../../packages/supervisor/src/index.ts';
import { Orchestrator, type WorkerSpec } from './orchestrator.ts';
import { LiveTurnRunner } from './turn-runner.ts';

vi.setConfig({ testTimeout: 120000 });
const fixture = (name: string) =>
  fileURLToPath(new URL('../../../tests/fixtures/' + name, import.meta.url));
let root: string, repo: string, store: Store, objects: ArtifactStore;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-turns-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      {
        cwd: repo,
      },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  store = new Store(join(root, 'state.sqlite'), { owner: 'test' });
  objects = new ArtifactStore(join(root, 'objects'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('orchestrates nodes on all three runtimes through their live controllers', async () => {
  const workers: WorkerSpec[] = [
    {
      alias: 'codex-1',
      runtimeKind: 'codex',
      quotaGroupId: 'chatgpt',
      roles: ['worker'],
    },
    {
      alias: 'claude-1',
      runtimeKind: 'claude',
      quotaGroupId: 'claude',
      roles: ['worker', 'reviewer'],
    },
    {
      alias: 'opencode-1',
      runtimeKind: 'opencode',
      quotaGroupId: 'free',
      roles: ['worker'],
    },
  ];
  const runner = new LiveTurnRunner(
    store,
    objects,
    workers,
    {
      codex: {
        executable: process.execPath,
        prefixArgs: [fixture('codex-live-peer.mjs'), 'write'],
      },
      claude: {
        executable: process.execPath,
        prefixArgs: [fixture('claude-live-peer.mjs'), 'write'],
      },
      opencode: {
        executable: process.execPath,
        prefixArgs: [fixture('opencode-cli.mjs'), 'tools'],
      },
    },
    { timeoutMs: 20000 },
  );
  const node = (id: string, assignee: string) => ({
    id,
    title: id,
    objective:
      'Create a file named ' +
      id +
      '.txt in the current directory whose entire content is the single line: ' +
      id +
      ' ok. Do not change anything else.',
    acceptanceCriteria: [id + '.txt exists'],
    assignee,
    writablePaths: [id + '.txt'],
  });
  const state = await new Orchestrator(store, runner, workers, {
    stateRoot: join(root, 'runs'),
  }).run({
    id: 'app',
    projectId: 'p',
    repository: repo,
    baseRevision: 'main',
    objective: 'Create three files',
    acceptanceCriteria: ['all exist'],
    checks: {
      files: {
        executable: process.execPath,
        args: [
          '-e',
          "for(const f of ['a','b','c'])require('node:fs').readFileSync(f+'.txt')",
        ],
      },
    },
    plan: {
      summary: 'three files',
      nodes: [
        node('a', '@codex-1'),
        node('b', '@claude-1'),
        node('c', '@opencode-1'),
      ],
    },
  });
  expect(state.reason).toBeUndefined();
  expect(state.phase).toBe('ready');
  expect(
    Object.values(state.nodes)
      .map((n) => n.attempts[0]!.alias)
      .sort(),
  ).toEqual(['claude-1', 'codex-1', 'opencode-1']);
  for (const f of ['a', 'b', 'c'])
    expect(existsSync(join(state.integration!.path, f + '.txt'))).toBe(true);
  // Every node turn was verified by the host and accepted by the orchestrator actor.
  for (const n of Object.values(state.nodes)) {
    const task = store.getTask(n.attempts[0]!.taskId);
    expect(task.state).toBe('accepted');
  }
  // claude-1 approves, but it also built node b: not an independent review.
  // claude-1 also built node b, so its review is recorded as not independent.
  expect(state.review).toMatchObject({
    alias: 'claude-1',
    approve: true,
    independent: false,
  });
});

it('names why a node check failed so the repair prompt can fix it', async () => {
  const workers: WorkerSpec[] = [
    {
      alias: 'codex-1',
      runtimeKind: 'codex',
      quotaGroupId: 'chatgpt',
      roles: ['worker'],
    },
  ];
  const runner = new LiveTurnRunner(
    store,
    objects,
    workers,
    {
      codex: {
        executable: process.execPath,
        prefixArgs: [fixture('codex-live-peer.mjs'), 'write'],
      },
    },
    { timeoutMs: 20000 },
  );
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo })
    .toString()
    .trim();
  const outcome = await runner.run({
    taskId: 'node-a',
    projectId: 'p',
    alias: 'codex-1',
    prompt:
      'Create a file named a.txt in the current directory whose entire content is the single line: a ok. Do not change anything else.',
    workspace: { path: repo, baseCommit },
    checks: {
      unit: {
        executable: process.execPath,
        args: [
          '-e',
          "console.error('AssertionError: expected answer 42, got 41'); process.exit(1)",
        ],
      },
    },
  });
  expect(outcome.status).toBe('verification_failed');
  expect(outcome.failure).toContain('Checks failed: unit');
  expect(outcome.failure).toContain('expected answer 42, got 41');
});

it('writes large prompts as bounded UTF-8 pieces', async () => {
  const pieces: string[] = [];
  const text = 'é'.repeat(50000) + 'end';
  await writeChunked(async (piece) => void pieces.push(piece), text, 1000);
  expect(pieces.join('')).toBe(text);
  expect(pieces.every((p) => Buffer.byteLength(p) <= 1000)).toBe(true);
});
