import { afterEach, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../packages/storage/src/store.ts';
import { lessonScope } from '../packages/storage/src/lesson-scope.ts';
import type { RootState } from '../apps/controller/src/orchestrator.ts';

import * as shell from '../apps/controller/src/shell.ts';

const cli = fileURLToPath(new URL('../scripts/xvant.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Shell test',
      '-c',
      'user.email=shell@local.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
};
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-shell-')));
  roots.push(root);
  const repo = join(root, 'repo');
  const home = join(root, 'state');
  const integration = join(root, 'integration');
  mkdirSync(repo);
  mkdirSync(home);
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-b', 'xvant/accepted', integration);
  writeFileSync(join(integration, 'result.txt'), 'verified result\n');
  git(integration, 'add', '.');
  git(integration, 'commit', '-qm', 'result');
  const state: RootState = {
    phase: 'ready',
    repository: repo,
    objective: 'offline shell regression',
    acceptanceCriteria: ['result exists'],
    plan: null,
    nodes: {},
    checks: [],
    review: null,
    integration: {
      branch: 'xvant/accepted',
      path: integration,
      baseCommit,
      head: git(integration, 'rev-parse', 'HEAD'),
    },
  };
  const save = (id = 'accepted', over: Partial<RootState> = {}) => {
    const store = new Store(join(home, 'state.sqlite'), {
      owner: 'shell-test',
    });
    try {
      store.graphs.create(id, 'test', { ...state, ...over }, {});
    } finally {
      store.close();
    }
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: repo,
      env: { ...process.env, XVANT_HOME: home },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
  return { root, repo, home, integration, state, baseCommit, save, run };
}

it('uses global color configuration for interactive Git commands, including merge', () => {
  const args = shell.gitArgs?.(['merge', '--no-edit', 'xvant/accepted'], true);
  expect(args).toEqual([
    '--no-pager',
    '-c',
    'color.ui=always',
    'merge',
    '--no-edit',
    'xvant/accepted',
  ]);
  expect(shell.gitArgs(['diff', 'HEAD'], false)).toEqual([
    '--no-pager',
    'diff',
    'HEAD',
  ]);
  const f = fixture();
  git(f.repo, ...args!);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.state.integration!.head);
});

it('merges the persisted accepted result after a separate CLI acceptance process', () => {
  const f = fixture();
  f.save();
  const accepted = f.run('accept', 'accepted');
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseCommit);
  const merged = f.run('merge', 'accepted', '--repo', f.repo);
  expect(merged.status, merged.stderr + merged.stdout).toBe(0);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.state.integration!.head);
});

it('merges an explicitly selected earlier accepted run through realpath aliases', () => {
  const f = fixture();
  const repoAlias = join(f.root, 'repo-alias');
  const integrationAlias = join(f.root, 'integration-alias');
  symlinkSync(f.repo, repoAlias, 'junction');
  symlinkSync(f.integration, integrationAlias, 'junction');
  f.save('earlier', {
    repository: repoAlias,
    integration: { ...f.state.integration!, path: integrationAlias },
  });
  expect(f.run('accept', 'earlier').status).toBe(0);
  f.save('latest', { phase: 'failed' });
  const merged = f.run('merge', 'earlier', '--repo', repoAlias);
  expect(merged.status, merged.stderr + merged.stdout).toBe(0);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.state.integration!.head);
});

it.each(['ready', 'failed', 'needs_attention', 'cancelled'] as const)(
  'refuses a persisted %s run without touching the checkout',
  (phase) => {
    const f = fixture();
    f.save('unaccepted', { phase });
    if (phase !== 'ready') expect(f.run('accept', 'unaccepted').status).toBe(1);
    const merged = f.run('merge', 'unaccepted', '--repo', f.repo);
    expect(merged.status).toBe(1);
    expect(merged.stderr).toContain('Only an accepted result can be merged');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseCommit);
  },
);

it.each(['clone', 'worktree'] as const)(
  'refuses merging into another %s with the same commit objects',
  (kind) => {
    const f = fixture();
    f.save('accepted', { phase: 'accepted' });
    const other = join(f.root, 'other');
    if (kind === 'clone') git(f.root, 'clone', '--quiet', f.repo, other);
    else
      git(
        f.repo,
        'worktree',
        'add',
        '-b',
        'other-checkout',
        other,
        f.baseCommit,
      );
    const merged = f.run('merge', 'accepted', '--repo', other);
    expect(merged.status, merged.stdout + merged.stderr).toBe(1);
    expect(merged.stderr).toContain('REPOSITORY_MISMATCH');
    expect(git(other, 'rev-parse', 'HEAD')).toBe(f.baseCommit);
  },
);

it.each([
  'moved-head',
  'wrong-branch',
  'foreign-worktree',
  'missing-integration',
  'invalid-branch',
] as const)('refuses accepted integration identity drift: %s', (change) => {
  const f = fixture();
  const integration = { ...f.state.integration! };
  if (change === 'moved-head')
    git(f.integration, 'reset', '--hard', f.baseCommit);
  if (change === 'wrong-branch') git(f.integration, 'switch', '-c', 'imposter');
  if (change === 'foreign-worktree') {
    const foreign = join(f.root, 'foreign');
    git(f.root, 'clone', '--quiet', f.repo, foreign);
    git(
      foreign,
      'switch',
      '--quiet',
      '-c',
      integration.branch,
      integration.head,
    );
    integration.path = foreign;
  }
  if (change === 'invalid-branch') integration.branch = '--help';
  f.save('accepted', {
    phase: 'accepted',
    integration: change === 'missing-integration' ? null : integration,
  });
  const merged = f.run('merge', 'accepted', '--repo', f.repo);
  expect(merged.status, merged.stdout + merged.stderr).toBe(1);
  expect(merged.stderr).toContain('INTEGRATION_CHANGED');
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseCommit);
});

it('does not persist acceptance of a ready result whose verified HEAD moved', () => {
  const f = fixture();
  f.save();
  git(f.integration, 'reset', '--hard', f.baseCommit);
  const accepted = f.run('accept', 'accepted');
  expect(accepted.status, accepted.stdout + accepted.stderr).toBe(1);
  expect(accepted.stderr).toContain('INTEGRATION_CHANGED');
  const store = new Store(join(f.home, 'state.sqlite'), {
    owner: 'shell-test',
  });
  try {
    expect(store.graphs.get<RootState>('accepted').state.phase).toBe('ready');
  } finally {
    store.close();
  }
  expect(f.run('merge', 'accepted', '--repo', f.repo).status).toBe(1);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseCommit);
});

it.each(['unreachable', 'rejected-push'] as const)(
  'share --once exits nonzero for %s',
  (failure) => {
    const f = fixture();
    const remote = join(f.root, 'remote.git');
    if (failure === 'rejected-push') {
      git(f.root, 'init', '--bare', remote);
      writeFileSync(
        join(remote, 'hooks', 'pre-receive'),
        '#!/bin/sh\nexit 1\n',
        { mode: 0o755 },
      );
    }
    git(f.repo, 'remote', 'add', 'origin', remote);
    const result = f.run(
      'share',
      '--repo',
      f.repo,
      '--branch',
      'main',
      '--once',
    );
    expect(result.stdout).toContain(
      failure === 'unreachable' ? 'Remote unreachable' : 'Push not accepted',
    );
    expect(result.status, result.stderr + result.stdout).toBe(1);
  },
);

it('share --once succeeds after a completed local publication', () => {
  const f = fixture();
  const remote = join(f.root, 'remote.git');
  git(f.root, 'init', '--bare', remote);
  git(f.repo, 'remote', 'add', 'origin', remote);
  const result = f.run('share', '--repo', f.repo, '--branch', 'main', '--once');
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(f.baseCommit);
});

it('continuous sharing retries an unreachable local remote instead of exiting', async () => {
  const f = fixture();
  git(f.repo, 'remote', 'add', 'origin', join(f.root, 'missing.git'));
  let output = '';
  const child = spawn(
    process.execPath,
    [cli, 'share', '--repo', f.repo, '--branch', 'main', '--interval', '1'],
    {
      cwd: f.repo,
      env: { ...process.env, XVANT_HOME: f.home },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('No second sharing cycle: ' + output));
    }, 12000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.split('Remote unreachable').length >= 3) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      done();
    });
  });
  expect(output).toContain('Sharing ');
  expect(output.split('Remote unreachable').length).toBeGreaterThanOrEqual(3);
}, 20000);

it('refuses an unknown run even after a failed acceptance', () => {
  const f = fixture();
  expect(f.run('accept', 'missing').status).toBe(1);
  const merged = f.run('merge', 'missing', '--repo', f.repo);
  expect(merged.status).toBe(1);
  expect(merged.stderr).toContain('No run named missing');
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.baseCommit);
});

/** Lesson stats as a run stores them. */
const lessonsOf = (
  scope: string,
  hinted: [number, number],
  unhinted: [number, number],
) => ({
  challenges: 2,
  solutions: 1,
  hinted: 1,
  errors: 0,
  scope,
  repairs: {
    hinted: { passed: hinted[0], failed: hinted[1] },
    unhinted: { passed: unhinted[0], failed: unhinted[1] },
  },
});

it('lessons stats counts only the runs of the repository it is asked about', () => {
  const f = fixture();
  const mine = lessonScope(f.repo);
  const store = new Store(join(f.home, 'state.sqlite'), {
    owner: 'shell-test',
  });
  try {
    store.graphs.create(
      'run1',
      'cli',
      { ...f.state, lessons: lessonsOf(mine, [3, 0], [1, 2]) },
      {},
    );
    store.graphs.create(
      'run2',
      'cli',
      { ...f.state, lessons: lessonsOf(mine, [1, 1], [0, 1]) },
      {},
    );
    // Another repository's run, and a run stored before lessons had a scope.
    store.graphs.create(
      'other',
      'cli',
      { ...f.state, lessons: lessonsOf('repo_elsewhere', [9, 0], [0, 9]) },
      {},
    );
    store.graphs.create(
      'oldrun',
      'cli',
      {
        ...f.state,
        lessons: { challenges: 1, solutions: 0, hinted: 0, errors: 0 },
      },
      {},
    );
  } finally {
    store.close();
  }
  const text = f.run('lessons', 'stats');
  expect(text.status, text.stderr).toBe(0);
  expect(text.stdout).toContain('2 runs');
  expect(text.stdout).toContain(
    'hinted (prompt carried lessons): 4/5 passed (80%)',
  );
  expect(text.stdout).toContain('unhinted: 1/4 passed (25%)');
  expect(text.stdout).toContain('Sample too small to compare');
  const json = f.run('lessons', 'stats', '--format', 'json');
  expect(json.status, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({
    project: mine,
    runs: 2,
    comparable: false,
    repairs: {
      hinted: { passed: 4, failed: 1 },
      unhinted: { passed: 1, failed: 3 },
    },
  });
  // The other repository sees only its own run.
  const other = f.run('lessons', 'stats', '--project', 'repo_elsewhere');
  expect(other.stdout).toContain('1 run');
  expect(other.stdout).toContain('9/9 passed (100%)');
}, 30000);

it('status and run summaries show one lessons line, or none when idle', () => {
  const f = fixture();
  f.save('withlessons', {
    lessons: lessonsOf('repo_x', [1, 0], [0, 1]),
  });
  f.save('idle', {
    lessons: { challenges: 0, solutions: 0, hinted: 0, errors: 0 },
  });
  const shown = f.run('status', 'withlessons');
  expect(shown.status, shown.stderr).toBe(0);
  expect(shown.stdout).toContain(
    'Lessons: 2 challenges, 1 fix recorded, repairs hinted 1/1 passed, unhinted 0/1 passed',
  );
  const idle = f.run('status', 'idle');
  expect(idle.status, idle.stderr).toBe(0);
  expect(idle.stdout).not.toContain('Lessons:');
});

it('lessons forget hides a node from list, keeps it for audit and shows the mark', () => {
  const f = fixture();
  const scope = lessonScope(f.repo);
  const store = new Store(join(f.home, 'state.sqlite'), {
    owner: 'shell-test',
  });
  let challengeId: string;
  let solutionId: string;
  try {
    const challenge = store.lessons.recordChallenge({
      projectId: scope,
      failure: 'Checks failed: unit\nError: widget missing',
      source: 'node',
      provenance: { graphId: 'run1' },
    });
    const solution = store.lessons.recordSolution({
      projectId: scope,
      summary: 'Added the widget',
      files: ['widget.js'],
      diff: '+widget',
      checks: ['unit'],
      provenance: { graphId: 'run1' },
    });
    store.lessons.link(scope, challenge.id, solution.id, 'solved_by');
    challengeId = challenge.id;
    solutionId = solution.id;
  } finally {
    store.close();
  }
  expect(f.run('lessons', 'list').stdout).toContain(challengeId);
  expect(
    f.run('lessons', 'search', 'Checks failed: unit Error: widget missing')
      .stdout,
  ).toContain('Added the widget');

  // A reason is required: usage, exit 2, nothing forgotten.
  for (const args of [
    ['forget', challengeId],
    ['forget', challengeId, '--reason', '  '],
    ['forget', '--reason', 'why'],
  ]) {
    const refused = f.run('lessons', ...args);
    expect(refused.status, args.join(' ')).toBe(2);
    expect(refused.stderr).toContain('Usage: lessons');
  }
  expect(f.run('lessons', 'list').stdout).toContain(challengeId);

  const missing = f.run('lessons', 'forget', 'ch_nope', '--reason', 'why');
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('No lesson ch_nope');

  const forgotSolution = f.run(
    'lessons',
    'forget',
    solutionId,
    '--reason',
    'did not really work',
  );
  expect(forgotSolution.status, forgotSolution.stderr).toBe(0);
  expect(forgotSolution.stdout).toContain('Forgot solution ' + solutionId);
  // Nothing is left to offer for that failure.
  expect(
    f.run('lessons', 'search', 'Checks failed: unit Error: widget missing')
      .stdout,
  ).toContain('No matching lessons');

  const forgotChallenge = f.run(
    'lessons',
    'forget',
    challengeId,
    '--reason',
    'stale',
  );
  expect(forgotChallenge.status, forgotChallenge.stderr).toBe(0);
  expect(f.run('lessons', 'list').stdout).not.toContain(challengeId);
  expect(f.run('lessons', 'list', '--all').stdout).toContain(
    '[forgotten] Checks failed: unit',
  );
  const shown = f.run('lessons', 'show', challengeId);
  expect(shown.stdout).toMatch(/^FORGOTTEN \d{4}-\d\d-\d\dT.*: stale/);
  expect(shown.stdout).toContain('"reason": "stale"');
  expect(f.run('lessons', 'export').stdout).toContain('0 challenges');
  expect(f.run('lessons', 'export', '--all').stdout).toContain('1 challenges');
}, 60000);
