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
