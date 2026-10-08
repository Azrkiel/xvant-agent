import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Each test creates several real Git worktrees, which is slow on Windows.
vi.setConfig({ testTimeout: 60000 });
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
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { captureGitWorkspace } from '../../../packages/storage/src/git-workspace.ts';
import {
  Orchestrator,
  type TurnOutcome,
  type TurnRequest,
  type TurnRunner,
  type WorkerSpec,
} from './orchestrator.ts';

let root: string, repo: string, store: Store, objects: ArtifactStore;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-orch-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  store = new Store(join(root, 'state.sqlite'), { owner: 'test' });
  objects = new ArtifactStore(join(root, 'objects'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const workers: WorkerSpec[] = [
  {
    alias: 'codex-1',
    runtimeKind: 'codex',
    quotaGroupId: 'chatgpt',
    roles: ['planner', 'worker'],
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
type Script = (
  request: TurnRequest,
  n: number,
) => Partial<TurnOutcome> & {
  write?: Record<string, string>;
};
/** Edits the real worktree and returns its real patch, like a live runner. */
class FakeRunner implements TurnRunner {
  calls: { taskId: string; alias: string; prompt: string }[] = [];
  active = 0;
  maxActive = 0;
  readonly script: Script;
  constructor(script: Script) {
    this.script = script;
  }
  interrupt() {
    return true;
  }
  async run(request: TurnRequest): Promise<TurnOutcome> {
    this.calls.push({
      taskId: request.taskId,
      alias: request.alias,
      prompt: request.prompt,
    });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, 20));
    try {
      const out = this.script(request, this.calls.length);
      for (const [path, text] of Object.entries(out.write ?? {}))
        writeFileSync(join(request.workspace.path, path), text);
      const snap = captureGitWorkspace(
        request.workspace.path,
        request.workspace.baseCommit,
        objects,
      );
      const manifest = JSON.parse(objects.get(snap.treeHash).toString());
      return {
        status: out.status ?? 'accepted',
        finalText: out.finalText ?? 'done',
        patch: objects.get(manifest.patch),
        files: manifest.files.map((f: { path: string }) => f.path),
        ...(out.failure ? { failure: out.failure } : {}),
      };
    } finally {
      this.active--;
    }
  }
}
const plan = {
  summary: 'parallel feature',
  nodes: [
    {
      id: 'api',
      title: 'API',
      objective: 'api',
      acceptanceCriteria: ['api.txt'],
      writablePaths: ['api.txt'],
    },
    {
      id: 'web',
      title: 'Web',
      objective: 'web',
      acceptanceCriteria: ['web.txt'],
      writablePaths: ['web.txt'],
    },
    {
      id: 'docs',
      title: 'Docs',
      objective: 'docs',
      acceptanceCriteria: ['docs.txt'],
      dependsOn: ['api', 'web'],
      writablePaths: ['docs.txt'],
    },
  ],
};
const allFiles = {
  all: {
    executable: process.execPath,
    args: [
      '-e',
      "for(const f of ['api.txt','web.txt','docs.txt'])require('node:fs').readFileSync(f)",
    ],
  },
};
const byLabel = (request: TurnRequest) =>
  request.taskId.split('-').slice(1, -1).join('-');
const orchestrate = (runner: TurnRunner, extra: Record<string, unknown> = {}) =>
  new Orchestrator(store, runner, workers, {
    stateRoot: join(root, 'runs'),
  }).run({
    id: 'feature',
    projectId: 'p',
    repository: repo,
    baseRevision: 'main',
    objective: 'Add api, web and docs',
    acceptanceCriteria: ['all three files exist'],
    checks: allFiles,
    ...extra,
  });

it('plans, runs parallel nodes, integrates, verifies and reviews independently', async () => {
  const runner = new FakeRunner((request) => {
    const label = byLabel(request);
    if (label === 'plan')
      return { finalText: '```json\n' + JSON.stringify(plan) + '\n```' };
    if (label === 'review')
      return { finalText: '```json\n{"approve":true,"findings":[]}\n```' };
    return {
      write: { [label + '.txt']: label + ' by ' + request.alias + '\n' },
    };
  });
  const state = await orchestrate(runner);
  expect(state.reason).toBeUndefined();
  expect(state.phase).toBe('ready');
  expect(Object.values(state.nodes).map((n) => n.status)).toEqual([
    'integrated',
    'integrated',
    'integrated',
  ]);
  expect(state.checks).toEqual([
    { id: 'all', status: 'passed', head: state.integration!.head },
  ]);
  expect(state.review).toMatchObject({ approve: true, independent: true });
  const implementers = Object.values(state.nodes).map(
    (n) => n.attempts[0]!.alias,
  );
  const reviewer = state.review!.alias;
  expect(workers.find((w) => w.alias === reviewer)!.runtimeKind).not.toBe(
    'codex',
  );
  expect(new Set(implementers).size).toBeGreaterThan(1);
  // The integration branch holds the combined work; the user's checkout is untouched.
  const int = state.integration!.path;
  for (const f of ['api.txt', 'web.txt', 'docs.txt'])
    expect(existsSync(join(int, f))).toBe(true);
  expect(existsSync(join(repo, 'api.txt'))).toBe(false);
  expect(
    git(repo, 'log', '--oneline', 'xvant/feature').split('\n'),
  ).toHaveLength(4);
  // Docs waited for both dependencies and saw them in its worktree.
  const docs = runner.calls.find(
    (c) => byLabel({ taskId: c.taskId } as TurnRequest) === 'docs',
  )!;
  expect(docs.prompt).toMatch(/Already done[\s\S]*API[\s\S]*Web/);
  expect(runner.maxActive).toBeLessThanOrEqual(2);
  expect(store.graphs.events('feature').map((e) => e.kind)).toContain(
    'graph.ready',
  );
});

it('repairs a failed node once and stops a repeated identical failure', async () => {
  let webTries = 0;
  const runner = new FakeRunner((request) => {
    const label = byLabel(request);
    if (label === 'web' && ++webTries === 1)
      return { status: 'verification_failed', failure: 'Checks failed: lint' };
    if (label === 'api')
      return { status: 'failed', failure: 'WORKER_FAILED:x' };
    return { write: { [label + '.txt']: 'x\n' } };
  });
  const state = await orchestrate(runner, { plan, review: false });
  expect(state.nodes.web!.repairs).toBe(1);
  expect(state.nodes.web!.status).toBe('integrated');
  expect(state.nodes.web!.attempts[1]!.taskId).not.toBe(
    state.nodes.web!.attempts[0]!.taskId,
  );
  expect(
    runner.calls.find((c) => c.taskId === state.nodes.web!.attempts[1]!.taskId)!
      .prompt,
  ).toMatch(/Previous attempt failed[\s\S]*lint/);
  expect(state.nodes.api!.status).toBe('failed');
  expect(state.nodes.api!.attempts).toHaveLength(2);
  expect(state.phase).toBe('failed');
  expect(state.nodes.docs!.status).toBe('pending');
});

it('passes check output to the repair and treats changing output as the same failure', async () => {
  let apiTries = 0;
  const runner = new FakeRunner((request) => {
    const label = byLabel(request);
    if (label === 'api')
      return {
        status: 'verification_failed',
        failure:
          'Checks failed: unit\n\n### Output of unit\nexpected 42, got 41 (' +
          ++apiTries +
          ' ms)',
      };
    return { write: { [label + '.txt']: 'x\n' } };
  });
  const state = await orchestrate(runner, { plan, review: false });
  const api = state.nodes.api!;
  expect(api.status).toBe('failed');
  expect(api.attempts).toHaveLength(2);
  expect(
    runner.calls.find((c) => c.taskId === api.attempts[1]!.taskId)!.prompt,
  ).toMatch(/Previous attempt failed[\s\S]*expected 42, got 41 \(1 ms\)/);
});

it('never retries an unknown outcome', async () => {
  const runner = new FakeRunner((request) =>
    byLabel(request) === 'api'
      ? { status: 'unknown' }
      : { write: { [byLabel(request) + '.txt']: 'x' } },
  );
  const state = await orchestrate(runner, { plan, review: false });
  expect(state.phase).toBe('needs_attention');
  expect(
    runner.calls.filter(
      (c) => byLabel({ taskId: c.taskId } as TurnRequest) === 'api',
    ),
  ).toHaveLength(1);
});

it('reruns a node that conflicts on the new integration head', async () => {
  const conflicting = {
    summary: 's',
    nodes: [
      {
        id: 'one',
        title: 'One',
        objective: 'o',
        acceptanceCriteria: ['c'],
        writablePaths: ['one.txt'],
      },
      {
        id: 'two',
        title: 'Two',
        objective: 't',
        acceptanceCriteria: ['c'],
        writablePaths: ['two.txt'],
      },
    ],
  };
  const runner = new FakeRunner((request) => ({
    // Both edit README.md despite their declared scopes.
    write: { 'README.md': byLabel(request) + '\n' },
  }));
  const state = await orchestrate(runner, {
    plan: conflicting,
    review: false,
    checks: {},
  });
  const attempts = Object.values(state.nodes)
    .map((n) => n.attempts.length)
    .sort();
  expect(attempts).toEqual([1, 2]);
  expect(
    Object.values(state.nodes).find((n) => n.attempts.length === 2)!
      .attempts[0]!.status,
  ).toBe('accepted');
  expect(state.phase).toBe('ready');
});

it('re-plans once after an invalid plan and fixes a failing combined check', async () => {
  let plans = 0;
  const runner = new FakeRunner((request) => {
    const label = byLabel(request);
    if (label === 'plan')
      return {
        finalText:
          ++plans === 1
            ? 'no json here'
            : '```json\n' +
              JSON.stringify({ summary: 's', nodes: [plan.nodes[0]] }) +
              '\n```',
      };
    if (label === 'fix') return { write: { 'web.txt': 'w', 'docs.txt': 'd' } };
    return { write: { [label + '.txt']: 'x' } };
  });
  const state = await orchestrate(runner, { review: false });
  expect(plans).toBe(2);
  expect(
    runner.calls.find((c) => c.prompt.includes('previous plan was rejected')),
  ).toBeDefined();
  expect(state.phase).toBe('ready');
  const events = store.graphs.events('feature');
  expect(events.map((e) => e.kind)).toContain('graph.fix');
  expect(
    events.find((e) => e.kind === 'graph.plan_rejected')!.payload,
  ).toMatchObject({
    tries: 1,
    reason: 'INVALID_INPUT: Reply contains no JSON plan',
  });
});

it('rejects duplicate worker aliases', () =>
  expect(
    () =>
      new Orchestrator(
        store,
        new FakeRunner(() => ({})),
        [workers[0]!, { ...workers[0]! }],
        {
          stateRoot: root,
        },
      ),
  ).toThrow('DUPLICATE_IDENTITY'));

const verdict = (approve: boolean, findings: string[] = []) => ({
  finalText: '```json\n' + JSON.stringify({ approve, findings }) + '\n```',
});
const onlyApi = { summary: 's', nodes: [plan.nodes[0]!] };
const apiCheck = {
  api: {
    executable: process.execPath,
    args: ['-e', "require('node:fs').readFileSync('api.txt')"],
  },
};

it('repairs once after a rejecting review, then verifies and reviews again', async () => {
  let reviews = 0;
  const runner = new FakeRunner((request) => {
    const label = byLabel(request);
    if (label === 'review')
      return ++reviews === 1
        ? verdict(false, ['api.txt must say fixed'])
        : verdict(true);
    if (label === 'review-fix') return { write: { 'api.txt': 'fixed\n' } };
    return { write: { 'api.txt': 'first\n' } };
  });
  const state = await orchestrate(runner, { plan: onlyApi, checks: apiCheck });
  expect(state.phase).toBe('ready');
  expect(state.reviewRepairs).toBe(1);
  expect(state.review).toMatchObject({ approve: true });
  const fix = runner.calls.find((c) => c.taskId.includes('review-fix'))!;
  expect(fix.prompt).toContain('- api.txt must say fixed');
  // The fixer is not the reviewer, so the second review stays independent.
  expect(fix.alias).not.toBe(state.review!.alias);
  expect(state.review!.independent).toBe(true);
  const kinds = store.graphs.events('feature').map((e) => e.kind);
  expect(kinds.filter((k) => k === 'graph.reviewed')).toHaveLength(2);
  expect(kinds.filter((k) => k === 'graph.checked')).toHaveLength(2);
  expect(kinds).toContain('graph.review_fix');
  // The reviewed head is the repaired one.
  expect(state.checks[0]!.head).toBe(state.integration!.head);
  expect(git(state.integration!.path, 'show', 'HEAD:api.txt')).toBe('fixed');
});

it('hands over a review that still rejects after its one repair', async () => {
  let fixes = 0;
  const runner = new FakeRunner((request) => {
    const label = byLabel(request);
    if (label === 'review') return verdict(false, ['still wrong']);
    if (label === 'review-fix')
      return { write: { 'api.txt': 'try ' + ++fixes + '\n' } };
    return { write: { 'api.txt': 'first\n' } };
  });
  const state = await orchestrate(runner, { plan: onlyApi, checks: apiCheck });
  expect(fixes).toBe(1);
  expect(state.phase).toBe('ready');
  expect(state.review).toMatchObject({
    approve: false,
    findings: ['still wrong'],
  });
});

it('starts no repair for an approval, a rejection without findings, or a limit of zero', async () => {
  for (const [reply, extra] of [
    [verdict(true), {}],
    [verdict(false), {}],
    [verdict(false, ['wrong']), { maxReviewRepairs: 0 }],
  ] as const) {
    const runner = new FakeRunner((request) =>
      byLabel(request) === 'review'
        ? reply
        : { write: { 'api.txt': 'first\n' } },
    );
    const state = await new Orchestrator(store, runner, workers, {
      stateRoot: join(root, 'runs-' + runner.calls.length + Math.random()),
    }).run({
      id: 'r' + Math.random().toString(36).slice(2, 8),
      projectId: 'p',
      repository: repo,
      baseRevision: 'main',
      objective: 'Add api',
      acceptanceCriteria: ['api.txt exists'],
      checks: apiCheck,
      plan: onlyApi,
      ...extra,
    });
    expect(state.phase).toBe('ready');
    expect(state.reviewRepairs).toBeUndefined();
    expect(runner.calls.some((c) => c.taskId.includes('review-fix'))).toBe(
      false,
    );
  }
});

it('keeps the store lease while a check outlasts it', async () => {
  // No turn is running during verification, so nothing else renews the lease.
  const short = new Store(join(root, 'short.sqlite'), {
    owner: 'test',
    leaseMs: 3000,
  });
  try {
    const runner = new FakeRunner((request) =>
      byLabel(request) === 'review'
        ? { finalText: '```json\n{"approve":true,"findings":[]}\n```' }
        : { write: { 'api.txt': 'api\n' } },
    );
    const state = await new Orchestrator(short, runner, workers, {
      stateRoot: join(root, 'runs'),
    }).run({
      id: 'slow-check',
      projectId: 'p',
      repository: repo,
      baseRevision: 'main',
      objective: 'Add api',
      acceptanceCriteria: ['api.txt exists'],
      plan: onlyApi,
      checks: {
        slow: {
          executable: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 6000)'],
        },
      },
    });
    expect(state.reason).toBeUndefined();
    expect(state.phase).toBe('ready');
    expect(state.checks.map((c) => c.status)).toEqual(['passed']);
  } finally {
    short.close();
  }
});
