import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Each test runs real Git worktree commands, which take seconds on a loaded Windows host.
vi.setConfig({ testTimeout: 60000 });
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from './artifacts.ts';
import { captureGitWorkspace, createWorktree } from './git-workspace.ts';
import { IntegrationBranch } from './integration.ts';
import { Store } from './store.ts';

let root: string, repo: string, objects: ArtifactStore;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-int-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  objects = new ArtifactStore(join(root, 'objects'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const work = (name: string, edit: (dir: string) => void) => {
  const tree = createWorktree(repo, 'main', join(root, name), 'w/' + name);
  edit(tree.path);
  const snap = captureGitWorkspace(tree.path, tree.baseCommit, objects);
  return objects.get(JSON.parse(objects.get(snap.treeHash).toString()).patch);
};
const read = (p: string) => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');

it('applies independent patches one at a time and merges non-overlapping edits', () => {
  const branch = IntegrationBranch.create(
    repo,
    'main',
    join(root, 'int'),
    'xvant/root',
  );
  const first = work('w1', (d) =>
    writeFileSync(join(d, 'a.txt'), 'ONE\ntwo\nthree\n'),
  );
  const second = work('w2', (d) =>
    writeFileSync(join(d, 'a.txt'), 'one\ntwo\nTHREE\n'),
  );
  expect(branch.apply(first, 'first')).toMatchObject({
    status: 'applied',
    files: ['a.txt'],
  });
  expect(branch.apply(second, 'second')).toMatchObject({ status: 'applied' });
  expect(read(join(branch.path, 'a.txt'))).toBe('ONE\ntwo\nTHREE\n');
  expect(read(join(repo, 'a.txt'))).toBe('one\ntwo\nthree\n');
  expect(branch.diff()).toContain('+THREE');
});

it('reports a conflict and leaves the branch where it was', () => {
  const branch = IntegrationBranch.create(
    repo,
    'main',
    join(root, 'int'),
    'xvant/root',
  );
  const first = work('w1', (d) => writeFileSync(join(d, 'a.txt'), 'x\n'));
  const second = work('w2', (d) => writeFileSync(join(d, 'a.txt'), 'y\n'));
  branch.apply(first, 'first');
  const head = branch.head();
  expect(branch.apply(second, 'second')).toEqual({
    status: 'conflict',
    files: ['a.txt'],
  });
  expect(branch.head()).toBe(head);
  expect(git(branch.path, 'status', '--porcelain')).toBe('');
  expect(read(join(branch.path, 'a.txt'))).toBe('x\n');
});

it('treats an empty patch as a no-op and reopens after a restart', () => {
  const branch = IntegrationBranch.create(
    repo,
    'main',
    join(root, 'int'),
    'xvant/root',
  );
  expect(branch.apply(Buffer.alloc(0), 'none').status).toBe('empty');
  const again = IntegrationBranch.open(
    branch.path,
    'xvant/root',
    branch.baseCommit,
  );
  expect(again.head()).toBe(branch.head());
  writeFileSync(join(branch.path, 'stray.txt'), 'x');
  expect(() =>
    IntegrationBranch.open(branch.path, 'xvant/root', branch.baseCommit),
  ).toThrow('WORKSPACE_CHANGED');
});

it('persists work graphs with optimistic versions and an event history', () => {
  const store = new Store(join(root, 'state.sqlite'), { owner: 'test' });
  try {
    expect(store.schemaVersion()).toBe(4);
    const created = store.graphs.create(
      'root',
      'p',
      { phase: 'planning' },
      { why: 'start' },
    );
    expect(() => store.graphs.create('root', 'p', {}, {})).toThrow(
      'DUPLICATE_IDENTITY',
    );
    const next = store.graphs.update(
      'root',
      created.rowVersion,
      { phase: 'running' },
      'graph.planned',
      {},
    );
    expect(next.rowVersion).toBe(2);
    expect(() =>
      store.graphs.update('root', 1, { phase: 'x' }, 'graph.stale', {}),
    ).toThrow('CONFLICT');
    expect(store.graphs.get<{ phase: string }>('root').state.phase).toBe(
      'running',
    );
    expect(store.graphs.events('root').map((e) => e.kind)).toEqual([
      'graph.created',
      'graph.planned',
    ]);
    expect(store.graphs.list('p')).toEqual([
      { id: 'root', projectId: 'p', rowVersion: 2 },
    ]);
  } finally {
    store.close();
  }
});
