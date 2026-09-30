import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from './artifacts.ts';
import { verifiedWorkspaceObjects } from './workspace.ts';
import { captureGitWorkspace, createWorktree } from './git-workspace.ts';

let root: string, repo: string, objects: ArtifactStore, base: string;
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-git-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'gone.txt'), 'x\n');
  writeFileSync(join(repo, '.gitignore'), 'build/\n');
  git(repo, 'add', '.');
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    'base',
  );
  base = git(repo, 'rev-parse', 'HEAD');
  objects = new ArtifactStore(join(root, 'objects'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('creates an isolated worktree at a recorded base commit', () => {
  const tree = createWorktree(repo, 'main', join(root, 'w1'), 'xvant/w1');
  expect(tree.baseCommit).toBe(base);
  // Hosts with core.autocrlf check out CRLF; compare content, not line endings.
  const read = (p: string) => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
  expect(read(join(tree.path, 'a.txt'))).toBe('a\n');
  writeFileSync(join(tree.path, 'a.txt'), 'changed\n');
  expect(read(join(repo, 'a.txt'))).toBe('a\n');
  expect(() =>
    createWorktree(repo, 'main', join(root, 'w1'), 'xvant/w2'),
  ).toThrow();
});

it('captures working-tree changes as a patch against the base', () => {
  const { path } = createWorktree(repo, base, join(root, 'w'), 'xvant/w');
  const clean = captureGitWorkspace(path, base, objects);
  writeFileSync(join(path, 'a.txt'), 'a\nb\n');
  writeFileSync(join(path, 'new.txt'), 'new\n');
  rmSync(join(path, 'gone.txt'));
  mkdirSync(join(path, 'build'));
  writeFileSync(join(path, 'build', 'out.js'), 'ignored');
  const changed = captureGitWorkspace(path, base, objects);
  expect(changed.treeHash).not.toBe(clean.treeHash);
  expect(captureGitWorkspace(path, base, objects)).toEqual(changed);
  const manifest = JSON.parse(objects.get(changed.treeHash).toString());
  expect(manifest).toMatchObject({ version: 2, kind: 'git', baseCommit: base });
  expect(manifest.files).toEqual([
    { path: 'a.txt', status: 'M' },
    { path: 'gone.txt', status: 'D' },
    { path: 'new.txt', status: 'A' },
  ]);
  const patch = objects.get(manifest.patch).toString();
  expect(patch).toContain('+b');
  expect(patch).not.toContain('ignored');
  expect(verifiedWorkspaceObjects(objects, changed)).toEqual(
    changed.artifactHashes,
  );
  // The worker's own index and HEAD are untouched.
  expect(git(path, 'status', '--porcelain')).toContain('new.txt');
  expect(git(path, 'rev-parse', 'HEAD')).toBe(base);
});

it('is independent of commits the worker made', () => {
  const { path } = createWorktree(repo, base, join(root, 'w'), 'xvant/w');
  writeFileSync(join(path, 'a.txt'), 'committed\n');
  const before = captureGitWorkspace(path, base, objects);
  git(path, 'add', '.');
  git(path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'w');
  expect(captureGitWorkspace(path, base, objects).treeHash).toBe(
    before.treeHash,
  );
});

it('rejects a directory that is not the worktree root', () => {
  const { path } = createWorktree(repo, base, join(root, 'w'), 'xvant/w');
  mkdirSync(join(path, 'sub'));
  expect(() => captureGitWorkspace(join(path, 'sub'), base, objects)).toThrow(
    'UNSAFE_PATH',
  );
  expect(() => captureGitWorkspace(path, 'not-a-commit', objects)).toThrow(
    'INVALID_INPUT',
  );
});

it('rejects a tampered patch during verification', () => {
  const { path } = createWorktree(repo, base, join(root, 'w'), 'xvant/w');
  writeFileSync(join(path, 'a.txt'), 'z\n');
  const snap = captureGitWorkspace(path, base, objects);
  const manifest = JSON.parse(objects.get(snap.treeHash).toString());
  const forged = objects.put(
    Buffer.from(JSON.stringify({ ...manifest, patchBytes: 1 })),
  );
  expect(() =>
    verifiedWorkspaceObjects(objects, { ...snap, treeHash: forged }),
  ).toThrow();
});
