import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Store } from '../../../packages/storage/src/store.ts';
import { Orchestrator, type RootState } from './orchestrator.ts';

const cli = fileURLToPath(
  new URL('../../../scripts/xvant.mjs', import.meta.url),
);
const peer = fileURLToPath(
  new URL('../../../tests/fixtures/a02-workflow-peer.ts', import.meta.url),
);
let root: string;
let lease: number;
let base: string;
const db = () => join(root, 'state.sqlite');
const calls = () =>
  readFileSync(join(root, 'effects.log'), 'utf8').split('\n').filter(Boolean);
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
beforeEach(() => {
  lease = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-workflow-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const file of ['a.txt', 'b.txt'])
    writeFileSync(join(repo, file), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  base = git(repo, 'rev-parse', 'HEAD');
  appendFileSync(join(root, 'effects.log'), '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (operation: 'start' | 'resume', stopAt = '') =>
  spawnSync(
    process.execPath,
    [peer, root, operation, String(++lease), stopAt],
    {
      encoding: 'utf8',
      timeout: 15000,
    },
  );
function crash(operation: 'start' | 'resume', stopAt: string) {
  const result = run(operation, stopAt);
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.stderr).toContain('Forced termination at ' + stopAt + '\n');
  // Windows reports forced self-termination as an exit status.
  if (process.platform === 'win32' && result.signal === null) {
    expect(result.status, result.stderr).not.toBe(0);
  } else {
    expect(result.signal, result.stderr).toBe('SIGKILL');
  }
}
function snapshot() {
  const now = ++lease * 100000;
  const store = new Store(db(), {
    owner: 'inspection',
    now: () => now,
    recoverWorkGraphs: true,
  });
  try {
    return {
      graph: store.graphs.get<RootState>('root'),
      checkpoint: Orchestrator.checkpoint(store, 'root'),
      actions: store.workflows.actions('root'),
      events: store.graphs.events('root'),
      graphs: store.graphs.list(),
    };
  } finally {
    store.close();
  }
}

it('resumes the same graph after real crashes in planning, node integration, checks, and review', () => {
  crash('start', 'workflow.intent.before_commit:plan:0');
  const initial = snapshot();
  expect(initial.checkpoint.progress).toMatchObject({
    step: 'plan',
    turnCount: 0,
  });
  expect(initial.actions.map(({ slot }) => slot)).toEqual(['initialize']);
  expect(calls()).toEqual([]);

  crash('resume', 'workflow.result.after_commit:plan:0');
  expect(calls()).toEqual(['turn root-plan-1']);
  const planned = snapshot();
  expect(planned.actions.at(-1)).toMatchObject({
    slot: 'plan:0',
    status: 'completed',
  });

  crash('resume', 'workflow.intent.after_commit:node:first:0');
  const beforeNode = snapshot();
  const pending = beforeNode.actions.at(-1)!;
  expect(pending).toMatchObject({
    slot: 'node:first:0',
    status: 'prepared',
    input: {
      taskId: 'root-first-2',
      workspace: { baseCommit: base },
      deadlineAt: expect.any(Number),
    },
  });
  expect(beforeNode.graph.state.nodes.first!.status).toBe('running');
  expect(calls()).toEqual(['turn root-plan-1']);

  crash('resume', 'workflow.result.after_commit:apply:node:first:0');
  const applied = snapshot();
  const identity = applied.graph.state.integration!;
  const advanced = git(identity.path, 'rev-parse', 'HEAD');
  expect(advanced).not.toBe(identity.head);
  expect(
    applied.actions.find(({ slot }) => slot === pending.slot)?.input,
  ).toEqual(pending.input);

  crash('resume', 'workflow.result.after_commit:check:0:0:verify');
  const checked = snapshot();
  expect(checked.checkpoint.progress).toMatchObject({
    step: 'checks',
    checkRound: 0,
    reviewRound: 0,
  });
  expect(checked.graph.state.nodes.first!.attempts).toHaveLength(1);
  expect(checked.graph.state.nodes.second!.attempts).toHaveLength(1);
  expect(calls()).toEqual([
    'turn root-plan-1',
    'turn root-first-2',
    'turn root-second-3',
    'check',
  ]);

  crash('resume', 'workflow.result.after_commit:review:0');
  const reviewed = snapshot();
  expect(reviewed.checkpoint).toMatchObject({
    spec: { maxRepairs: 1, maxReviewRepairs: 1, checkTimeoutMs: 30000 },
    progress: { step: 'review', checkRound: 1, reviewRound: 0 },
  });
  crash('resume', 'workflow.result.after_commit:apply:review-repair:0');
  const result = run('resume');
  expect(result.status, result.stderr).toBe(0);
  const state = JSON.parse(result.stdout) as RootState;
  expect(state).toMatchObject({
    phase: 'ready',
    integration: {
      path: identity.path,
      branch: identity.branch,
      baseCommit: base,
    },
    review: { approve: true, independent: true },
    reviewRepairs: 1,
    checks: [{ id: 'verify', status: 'passed', head: state.integration!.head }],
  });
  expect(calls()).toEqual([
    'turn root-plan-1',
    'turn root-first-2',
    'turn root-second-3',
    'check',
    'turn root-fix-4',
    'check',
    'turn root-review-5',
    'turn root-review-fix-6',
    'check',
    'turn root-review-7',
  ]);
  expect(git(identity.path, 'rev-list', '--count', base + '..HEAD')).toBe('4');
  expect(git(join(root, 'repo'), 'rev-parse', 'HEAD')).toBe(base);
  const done = snapshot();
  expect(done.graphs).toHaveLength(1);
  expect(done.checkpoint.progress).toMatchObject({
    step: 'done',
    turnCount: 7,
    reviewRound: 1,
  });
  expect(
    done.events.filter(({ kind }) => kind === 'node.integrated'),
  ).toHaveLength(2);
  expect(run('resume').status).toBe(0);
  const cliResult = spawnSync(process.execPath, [cli, 'resume', 'root'], {
    env: { ...process.env, XVANT_HOME: root },
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(cliResult.status, cliResult.stderr).toBe(0);
  expect(cliResult.stdout).toContain('Result: ready');
  expect(snapshot().graph.rowVersion).toBe(done.graph.rowVersion);
}, 60000);

it.each([
  'plan:0',
  'node:first:0',
  'apply:node:first:0',
  'check:0:0:verify',
  'review:0',
])(
  'leaves %s unresolved when a process dies after dispatch and before receipt',
  (slot) => {
    crash('start', 'workflow.result.before_commit:' + slot);
    const interrupted = snapshot();
    expect(
      interrupted.actions.find((action) => action.slot === slot),
    ).toMatchObject({ status: 'dispatching' });
    const effects = calls();
    const result = run('resume');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('UNRESOLVED_WORKFLOW_ACTION: ' + slot);
    expect(calls()).toEqual(effects);
    expect(snapshot().graph).toEqual(interrupted.graph);
  },
  30000,
);

it('rejects an incomplete executable checkpoint without defaulting its budgets or dispatching', () => {
  crash('start', 'workflow.intent.after_commit:plan:0');
  const interrupted = snapshot();
  const now = ++lease * 100000;
  const writer = new Store(db(), { owner: 'alter-fixture', now: () => now });
  try {
    const incomplete: Partial<typeof interrupted.checkpoint.spec> = {
      ...interrupted.checkpoint.spec,
    };
    delete incomplete.maxRepairs;
    writer.workflows.write('root', {
      ...interrupted.checkpoint,
      spec: incomplete,
    });
  } finally {
    writer.close();
  }
  const result = run('resume');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('CHECKPOINT_INVALID');
  expect(calls()).toEqual([]);
  const reader = new Store(db(), { owner: 'inspect-fixture', now: () => now });
  try {
    expect(reader.graphs.get('root')).toEqual(interrupted.graph);
    expect(reader.workflows.read('root')).toMatchObject({
      spec: { id: 'root' },
    });
    expect(
      (reader.workflows.read('root') as { spec: object }).spec,
    ).not.toHaveProperty('maxRepairs');
  } finally {
    reader.close();
  }
});

it('reports a changed integration checkout and preserves its contents', () => {
  crash('start', 'workflow.intent.after_commit:plan:0');
  const interrupted = snapshot();
  const path = interrupted.graph.state.integration!.path;
  writeFileSync(join(path, 'a.txt'), 'local edit\n');
  const result = run('resume');
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    phase: 'needs_attention',
    reason: 'WORKSPACE_CHANGED',
    integration: { head: base },
  });
  expect(calls()).toEqual([]);
  expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('local edit\n');
});
