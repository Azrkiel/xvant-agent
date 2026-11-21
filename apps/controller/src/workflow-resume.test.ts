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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
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

const run = (operation: 'start' | 'resume', stopAt = '', id = 'root') =>
  spawnSync(
    process.execPath,
    [peer, root, operation, String(++lease), stopAt, id],
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
      recoveries: store.workflows.recoveries('root'),
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

it.each(['plan:0', 'node:first:0', 'check:0:0:verify', 'review:0'])(
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
    const blocked = snapshot();
    expect(blocked.graph).toEqual(interrupted.graph);
    expect(blocked.recoveries.at(-1)).toMatchObject({
      slot,
      decision: 'block',
      classification:
        slot.startsWith('check:') && process.platform === 'linux'
          ? 'stopped_incomplete'
          : 'unresolved',
      operatorAction: expect.any(String),
    });
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

it('recovers the committed Git effect once, even when killed again before the cursor advances', () => {
  const slot = 'apply:node:second:0';
  crash('start', 'workflow.result.before_commit:' + slot);
  const before = snapshot();
  const action = before.actions.find((action) => action.slot === slot)!;
  expect(action.status).toBe('dispatching');
  const identity = before.graph.state.integration!;
  const applied = git(identity.path, 'rev-parse', 'HEAD');
  expect(git(identity.path, 'rev-parse', 'HEAD^')).toBe(identity.head);
  expect(before.graph.state.nodes.first!.status).toBe('integrated');
  expect(calls()).toEqual([
    'turn root-plan-1',
    'turn root-first-2',
    'turn root-second-3',
  ]);

  crash('resume', 'workflow.recovery.after_commit:' + slot);
  const reconciled = snapshot();
  expect(reconciled.checkpoint).toEqual(before.checkpoint);
  expect(reconciled.graph).toEqual(before.graph);
  expect(reconciled.actions.find((action) => action.slot === slot)).toEqual({
    ...action,
    status: 'completed',
    result: { status: 'applied', commit: applied, files: ['b.txt'] },
  });
  expect(reconciled.recoveries).toEqual([
    expect.objectContaining({
      slot,
      classification: 'completed_verifiable',
      decision: 'resume',
      source: 'git',
      dispatchGeneration: action.generation,
      generation: expect.any(Number),
      evidence: expect.objectContaining({
        parent: identity.head,
        head: applied,
        tree: expect.any(String),
      }),
    }),
  ]);
  expect(reconciled.recoveries[0]!.generation).toBeGreaterThan(
    action.generation,
  );
  expect(git(identity.path, 'rev-parse', 'HEAD')).toBe(applied);

  const result = run('resume');
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    phase: 'ready',
    integration: {
      path: identity.path,
      branch: identity.branch,
      baseCommit: identity.baseCommit,
    },
  });
  const done = snapshot();
  expect(done.checkpoint.spec).toEqual(before.checkpoint.spec);
  expect(done.checkpoint.progress).toMatchObject({
    step: 'done',
    turnCount: 7,
    checkRound: 0,
    reviewRound: 1,
  });
  expect(done.graphs).toHaveLength(1);
  expect(done.graph.state.nodes.first).toEqual(before.graph.state.nodes.first);
  expect(
    done.actions.slice(0, before.actions.length).map((action) => action.input),
  ).toEqual(before.actions.map((action) => action.input));
  expect(done.recoveries).toEqual(reconciled.recoveries);
  expect(git(identity.path, 'rev-list', '--count', base + '..HEAD')).toBe('4');
  expect(
    git(identity.path, 'rev-list', 'HEAD')
      .split('\n')
      .filter((commit) => commit === applied),
  ).toHaveLength(1);
  expect(calls().filter((call) => call === 'turn root-second-3')).toHaveLength(
    1,
  );
  expect(run('resume').status).toBe(0);
  expect(snapshot().graph).toEqual(done.graph);
}, 30_000);

it.each([
  ['dispatch.after_claim:plan:0', 'not_started', 'retry'],
  ['result.before_commit:initialize', 'completed_verifiable', 'resume'],
  ['result.after_observation:plan:0', 'completed_verifiable', 'resume'],
  ['result.after_observation:check:0:0:verify', 'stopped_incomplete', 'resume'],
])(
  'classifies a real crash at %s and resumes with the original intent',
  (point, classification, decision) => {
    crash('start', 'workflow.' + point);
    const before = snapshot();
    const original = before.actions.find(
      (action) => action.status === 'dispatching',
    )!;
    expect(original).toBeDefined();
    const result = run('resume');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ phase: 'ready' });
    const after = snapshot();
    const consumed = after.actions.find(
      (action) => action.slot === original.slot,
    )!;
    expect(consumed.input).toEqual(original.input);
    expect(consumed.status).toBe('completed');
    expect(after.recoveries).toEqual([
      expect.objectContaining({
        slot: original.slot,
        classification,
        decision,
      }),
    ]);
    expect(calls().filter((call) => call === 'turn root-plan-1')).toHaveLength(
      1,
    );
  },
  30_000,
);

it('blocks a crash after the authorization marker when there is no effect receipt', () => {
  crash('start', 'workflow.dispatch.after_arm:plan:0');
  expect(calls()).toEqual([]);
  const result = run('resume');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('UNRESOLVED_WORKFLOW_ACTION: plan:0');
  expect(calls()).toEqual([]);
  expect(snapshot().recoveries).toEqual([
    expect.objectContaining({
      classification: 'unresolved',
      decision: 'block',
    }),
  ]);
  const cliResult = spawnSync(process.execPath, [cli, 'resume', 'root'], {
    env: { ...process.env, XVANT_HOME: root },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(cliResult.status).toBe(1);
  expect(cliResult.stderr).toContain('plan:0 (root-plan-1-a1)');
  expect(cliResult.stderr).toContain('trustworthy worker identity');
  expect(cliResult.stderr).toContain('Inspect the original worker environment');
}, 30_000);

it.each([
  ['missing patch', 'ARTIFACT_MISSING'],
  ['dirty worktree', 'WORKSPACE_CHANGED'],
  ['unexpected head', 'INTEGRATION_CHANGED'],
  ['wrong committed tree', 'INTEGRATION_PATCH_MISMATCH'],
])(
  'blocks Git reconciliation with %s and keeps user files and refs',
  (scenario, code) => {
    const slot = 'apply:node:first:0';
    crash('start', 'workflow.result.before_commit:' + slot);
    const before = snapshot();
    const action = before.actions.find((action) => action.slot === slot)!;
    const { path } = before.graph.state.integration!;
    const repo = join(root, 'repo');
    writeFileSync(join(repo, 'user.txt'), 'user checkout\n');
    if (scenario === 'missing patch')
      rmSync(
        join(
          root,
          'objects',
          (action.input as { patchHash: string }).patchHash,
        ),
      );
    if (scenario === 'dirty worktree')
      writeFileSync(join(path, 'a.txt'), 'user worktree\n');
    if (scenario === 'unexpected head')
      git(path, 'commit', '--allow-empty', '-qm', 'unrelated');
    if (scenario === 'wrong committed tree') {
      writeFileSync(join(path, 'a.txt'), 'unrelated tree\n');
      git(path, 'add', 'a.txt');
      git(path, 'commit', '--amend', '--no-edit', '-q');
    }
    const head = git(path, 'rev-parse', 'HEAD');
    const effects = calls();
    const result = run('resume');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(code);
    const after = snapshot();
    expect(after.graph).toEqual(before.graph);
    expect(after.actions).toEqual(before.actions);
    expect(after.recoveries.at(-1)).toMatchObject({
      slot,
      decision: 'block',
      evidence: { code },
    });
    expect(calls()).toEqual(effects);
    expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(repo, 'user.txt'), 'utf8')).toBe(
      'user checkout\n',
    );
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe(
      scenario === 'dirty worktree'
        ? 'user worktree\n'
        : scenario === 'wrong committed tree'
          ? 'unrelated tree\n'
          : 'first\n',
    );
  },
  30_000,
);

it.each([
  ['hold-worker', 'owned_running', 'running'],
  ['hold-unidentified-worker', 'unresolved', null],
  ['reuse-pid', 'unresolved', 'pid_reused'],
])(
  'fences a late worker result and retains the reservation for %s',
  async (mode, classification, processState) => {
    const child = spawn(
      process.execPath,
      [
        peer,
        root,
        'start',
        String(++lease),
        mode === 'reuse-pid' ? 'hold-worker' : mode,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let diagnostics = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const started = join(root, 'worker-started');
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(started) && Date.now() < deadline) await delay(20);
      expect(existsSync(started), diagnostics).toBe(true);
      pid = Number(readFileSync(started, 'utf8'));
      const before = snapshot();
      const slot = 'node:first:0';
      const action = before.actions.find((action) => action.slot === slot)!;
      const workspace = (action.input as { workspace: { path: string } })
        .workspace.path;
      const linux = process.platform === 'linux';
      if (mode === 'reuse-pid' && linux) {
        // This live PID belongs to a different start tick than the persisted attempt.
        const writer = new Database(db());
        try {
          writer
            .prepare(
              "UPDATE work_dispatches SET body=json_set(body,'$.processes[0].start','0') WHERE id=?",
            )
            .run((action as { dispatchId: string }).dispatchId);
        } finally {
          writer.close();
        }
      }
      expect(run('resume').status).toBe(1);
      expect(snapshot().recoveries.at(-1)).toMatchObject({
        slot,
        classification: linux ? classification : 'unresolved',
        decision: 'block',
        evidence: {
          processes:
            linux && processState
              ? [expect.objectContaining({ pid, observed: processState })]
              : [],
        },
      });
      const conflict = run('start', '', 'conflicting');
      expect(conflict.status, conflict.stderr).toBe(0);
      expect(JSON.parse(conflict.stdout)).toMatchObject({
        phase: 'needs_attention',
        reason: 'RECOVERY_RESOURCE_BUSY: plan:0',
      });
      expect(calls()).toEqual(['turn root-plan-1', 'turn root-first-2']);
      expect(readFileSync(join(workspace, 'partial.txt'), 'utf8')).toBe(
        'partial',
      );
      expect(() => process.kill(pid!, 0)).not.toThrow();

      writeFileSync(join(root, 'worker-release'), '');
      expect(await exited, diagnostics).toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        phase: 'needs_attention',
        reason: 'STALE_FENCE',
      });
      expect(calls()).toEqual([
        'turn root-plan-1',
        'turn root-first-2',
        'late root-first-2',
      ]);
      expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('first\n');
      const after = snapshot();
      expect(after.actions).toEqual(before.actions);
      expect(after.checkpoint).toEqual(before.checkpoint);
      expect(after.graph).toEqual(before.graph);
      expect(
        git(before.graph.state.integration!.path, 'rev-parse', 'HEAD'),
      ).toBe(base);
    } finally {
      writeFileSync(join(root, 'worker-release'), '');
      if (child.exitCode === null) child.kill();
      await exited;
    }
  },
  30_000,
);
