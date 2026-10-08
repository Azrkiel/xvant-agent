import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Every test drives several real Git repositories, which is slow on Windows.
vi.setConfig({ testTimeout: 60000 });
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSync, syncOnce } from './share.ts';

let root: string, a: string, b: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const clone = (name: string) => {
  const path = join(root, name);
  git(
    root,
    'clone',
    '-q',
    '-c',
    'core.autocrlf=false',
    join(root, 'remote.git'),
    path,
  );
  git(path, 'config', 'user.name', name);
  git(path, 'config', 'user.email', name + '@local');
  git(path, 'config', 'core.autocrlf', 'false');
  return path;
};
const sync = (repository: string) => syncOnce({ repository, branch: 'shared' });
const read = (repository: string, path: string) =>
  readFileSync(join(repository, path), 'utf8');
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-share-')));
  git(root, 'init', '-q', '--bare', '-b', 'shared', 'remote.git');
  a = clone('ann');
  git(a, 'switch', '-q', '-c', 'shared');
  writeFileSync(join(a, 'notes.md'), 'one\ntwo\nthree\n');
  sync(a);
  b = clone('ben');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('publishes a new shared branch and carries edits between two accounts', () => {
  expect(read(b, 'notes.md')).toBe('one\ntwo\nthree\n');
  writeFileSync(join(b, 'plan.md'), 'from ben\n');
  const sent = sync(b);
  expect(sent).toMatchObject({ committed: ['plan.md'], pushed: true });
  expect(describeSync(sent)).toEqual(['sent     plan.md']);
  const received = sync(a);
  expect(received).toMatchObject({ pulled: 1, pushed: false, committed: [] });
  expect(read(a, 'plan.md')).toBe('from ben\n');
  expect(git(a, 'log', '-1', '--format=%an %s')).toBe(
    'ben share: 1 file(s) from ben',
  );
  // Nothing changed: a cycle does nothing and says nothing.
  expect(describeSync(sync(a))).toEqual([]);
});

it('merges edits to different files and to different lines of one file', () => {
  writeFileSync(join(a, 'notes.md'), 'ONE\ntwo\nthree\n');
  writeFileSync(join(b, 'notes.md'), 'one\ntwo\nTHREE\n');
  writeFileSync(join(b, 'ben.md'), 'b\n');
  sync(a);
  const merged = sync(b);
  expect(merged).toMatchObject({ pulled: 1, pushed: true, conflicts: [] });
  sync(a);
  for (const repository of [a, b]) {
    expect(read(repository, 'notes.md')).toBe('ONE\ntwo\nTHREE\n');
    expect(read(repository, 'ben.md')).toBe('b\n');
  }
});

it('keeps both versions when two accounts change the same line', () => {
  writeFileSync(join(a, 'notes.md'), 'one\nann\nthree\n');
  writeFileSync(join(b, 'notes.md'), 'one\nben\nthree\n');
  sync(a);
  const result = sync(b);
  expect(result.conflicts).toHaveLength(1);
  const { path, copy } = result.conflicts[0]!;
  expect(path).toBe('notes.md');
  expect(copy).toMatch(/^notes\.conflict-[0-9a-f]{7,}\.md$/);
  expect(result.pushed).toBe(true);
  sync(a);
  for (const repository of [a, b]) {
    expect(read(repository, 'notes.md')).toBe('one\nben\nthree\n');
    expect(read(repository, copy!)).toBe('one\nann\nthree\n');
  }
  expect(git(b, 'status', '--porcelain')).toBe('');
});

it('lets a change win over a deletion of the same file', () => {
  rmSync(join(b, 'notes.md'));
  writeFileSync(join(a, 'notes.md'), 'one\ntwo\nthree\nfour\n');
  sync(a);
  const result = sync(b);
  expect(result.conflicts).toEqual([{ path: 'notes.md', copy: null }]);
  expect(read(b, 'notes.md')).toBe('one\ntwo\nthree\nfour\n');
});

it('never commits files that look like credentials', () => {
  writeFileSync(join(b, '.env'), 'TOKEN=abc\n');
  writeFileSync(join(b, 'config.txt'), 'key ghp_' + 'a'.repeat(36) + '\n');
  writeFileSync(join(b, 'ok.txt'), 'fine\n');
  const result = sync(b);
  expect(result.committed).toEqual(['ok.txt']);
  expect(result.skipped.sort()).toEqual(['.env', 'config.txt']);
  sync(a);
  expect(existsSync(join(a, 'ok.txt'))).toBe(true);
  expect(existsSync(join(a, '.env'))).toBe(false);
  expect(existsSync(join(a, 'config.txt'))).toBe(false);
});

it('refuses a checkout on another branch, and reports an unreachable remote', () => {
  git(b, 'switch', '-q', '-c', 'mine');
  expect(() => sync(b)).toThrow('WRONG_BRANCH');
  git(a, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
  writeFileSync(join(a, 'later.md'), 'x\n');
  const result = sync(a);
  expect(result.committed).toEqual(['later.md']);
  expect(result.pushed).toBe(false);
  expect(result.note).toMatch(/^Remote unreachable/);
});
