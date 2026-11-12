import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
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
import { fileURLToPath } from 'node:url';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { lessonScope } from '../../../packages/storage/src/lesson-scope.ts';
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

it('runs a node whose run and node names are as long as the CLI makes them', async () => {
  const workers: WorkerSpec[] = [
    {
      alias: 'claude-1',
      runtimeKind: 'claude',
      quotaGroupId: 'claude',
      roles: ['worker'],
    },
  ];
  const runner = new LiveTurnRunner(
    store,
    objects,
    workers,
    {
      claude: {
        executable: process.execPath,
        prefixArgs: [fixture('claude-live-peer.mjs'), 'write'],
      },
    },
    { timeoutMs: 20000 },
  );
  const nodes = ['accepted-versions', 'n'.repeat(64)].map((id, i) => ({
    id,
    title: id,
    objective:
      'Create a file named f' +
      i +
      '.txt in the current directory whose entire content is the single line: ok. Do not change anything else.',
    acceptanceCriteria: ['the file exists'],
    assignee: '@claude-1',
    writablePaths: ['f' + i + '.txt'],
  }));
  const state = await new Orchestrator(store, runner, workers, {
    stateRoot: join(root, 'runs'),
  }).run({
    id: 'x261102051059-make-a-version-mismatch-',
    projectId: 'p',
    repository: repo,
    baseRevision: 'main',
    objective: 'Create two files',
    acceptanceCriteria: ['both exist'],
    checks: {},
    review: false,
    maxActive: 1,
    plan: { summary: 'two files', nodes },
  });
  expect(state.reason).toBeUndefined();
  expect(state.phase).toBe('ready');
  const taskIds = Object.values(state.nodes).map((n) => n.attempts[0]!.taskId);
  expect(new Set(taskIds).size).toBe(2);
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
  // The failed turn's process is known to have stopped, so the same worker
  // can take the repair instead of finding its own reservation still held.
  const repair = await runner.run({
    taskId: 'node-a-repair',
    projectId: 'p',
    alias: 'codex-1',
    prompt:
      'Create a file named a.txt in the current directory whose entire content is the single line: a ok. Do not change anything else.',
    workspace: { path: repo, baseCommit },
    checks: {
      unit: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
    },
  });
  expect(repair.status).toBe('accepted');
});

describe('read-only search tools on external runtimes', () => {
  const peers = {
    codex: [fixture('codex-live-peer.mjs'), 'write'],
    claude: [fixture('claude-live-peer.mjs'), 'write'],
    opencode: [fixture('opencode-cli.mjs'), 'tools'],
  } as const;
  const failure = 'Checks failed: unit\nTypeError: parse is not a function';
  const learn = (scope: string, summary: string) => {
    const challenge = store.lessons.recordChallenge({
      projectId: scope,
      failure,
      source: 'node',
      provenance: { graphId: 'g' },
    });
    const fix = store.lessons.recordSolution({
      projectId: scope,
      summary,
      files: ['src/parse.js'],
      diff: '+export { parse };',
      checks: ['unit'],
      provenance: { graphId: 'g' },
    });
    store.lessons.link(scope, challenge.id, fix.id, 'solved_by');
  };
  const search = async (
    kind: keyof typeof peers,
    extra: { lessonScope?: string | null } = {},
  ) => {
    const alias = kind + '-1';
    const worker: WorkerSpec = {
      alias,
      runtimeKind: kind,
      quotaGroupId: kind,
      roles: ['worker'],
    };
    const runner = new LiveTurnRunner(
      store,
      objects,
      [worker],
      {
        [kind]: {
          executable: process.execPath,
          prefixArgs: [...peers[kind]],
        },
      },
      { timeoutMs: 20000 },
    );
    const outcome = await runner.run({
      taskId: 'node-a',
      projectId: 'p',
      alias,
      prompt:
        'Call lessons_search on the MCP server named xvant for: TypeError: parse is not a function. Save it.',
      workspace: {
        path: repo,
        baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo })
          .toString()
          .trim(),
      },
      checks: {
        saved: {
          executable: process.execPath,
          args: ['-e', "require('node:fs').readFileSync('lessons.json')"],
        },
      },
      ...extra,
    });
    return {
      outcome,
      seen: JSON.parse(readFileSync(join(repo, 'lessons.json'), 'utf8')) as {
        tools: string[];
        result?: unknown;
      },
      receipts: store
        .events(0, 1000)
        .filter((event) => event.kind === 'tool.receipt')
        .map(
          (event) =>
            event.payload as { tool: string; status: string; taskId: string },
        ),
    };
  };
  it.each(['codex', 'claude', 'opencode'] as const)(
    '%s finds only its own repository’s lessons and leaves a receipt',
    async (kind) => {
      learn('some-other-repository', 'Fix recorded for repository A');
      learn(lessonScope(repo), 'Fix recorded for repository B');
      const { outcome, seen, receipts } = await search(kind);
      expect(outcome.status).toBe('accepted');
      // Read-only lookups and nothing that writes.
      expect(seen.tools).toEqual(['lessons_search', 'memory_search']);
      const text = JSON.stringify(seen.result);
      expect(text).toContain('Fix recorded for repository B');
      expect(text).not.toContain('repository A');
      expect(receipts).toEqual([
        expect.objectContaining({
          tool: 'lessons.search',
          status: 'succeeded',
          taskId: 'node-a',
        }),
      ]);
    },
  );
  it('offers no lessons tool when the run switched lessons off', async () => {
    learn(lessonScope(repo), 'Fix recorded for repository B');
    const { outcome, seen, receipts } = await search('claude', {
      lessonScope: null,
    });
    expect(outcome.status).toBe('accepted');
    expect(seen.tools).toEqual(['memory_search']);
    expect(seen.result).toBeUndefined();
    expect(receipts).toEqual([]);
  });
});

it('writes large prompts as bounded UTF-8 pieces', async () => {
  const pieces: string[] = [];
  const text = 'é'.repeat(50000) + 'end';
  await writeChunked(async (piece) => void pieces.push(piece), text, 1000);
  expect(pieces.join('')).toBe(text);
  expect(pieces.every((p) => Buffer.byteLength(p) <= 1000)).toBe(true);
});
