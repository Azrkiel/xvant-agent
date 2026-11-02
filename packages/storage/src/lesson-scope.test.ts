import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idSchema } from '../../contracts/src/index.ts';
import { lessonScope, normalizeRemoteUrl } from './lesson-scope.ts';

describe('normalizeRemoteUrl', () => {
  it('treats scp-like and URL forms of one repository as equal', () => {
    const forms = [
      'git@GitHub.com:Azrkiel/xvant.git',
      'https://github.com/Azrkiel/xvant',
      'https://github.com/Azrkiel/xvant.git/',
      'https://user:secret-token@GITHUB.com/Azrkiel/xvant.git',
      'ssh://git@github.com/Azrkiel/xvant.git',
      'github.com:Azrkiel/xvant',
    ];
    const first = normalizeRemoteUrl(forms[0]!);
    expect(first).toBe('github.com/Azrkiel/xvant');
    for (const form of forms) expect(normalizeRemoteUrl(form)).toBe(first);
  });
  it('keeps the path case and tells repositories apart', () => {
    expect(normalizeRemoteUrl('https://h/a/b')).not.toBe(
      normalizeRemoteUrl('https://h/a/c'),
    );
    expect(normalizeRemoteUrl('https://h/A/b')).not.toBe(
      normalizeRemoteUrl('https://h/a/b'),
    );
  });
  it('leaves a local path alone', () => {
    expect(normalizeRemoteUrl('C:\\work\\repo.git')).toBe('C:/work/repo');
    expect(normalizeRemoteUrl('/srv/git/repo.git/')).toBe('/srv/git/repo');
  });
});

describe('lessonScope', () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { cwd, encoding: 'utf8' },
    ).trim();
  const init = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    git(path, 'init', '-q', '-b', 'main');
    git(path, 'commit', '-q', '--allow-empty', '-m', 'base');
    return path;
  };
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-scope-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is a valid id that never contains the remote', () => {
    const a = init('a');
    git(
      a,
      'remote',
      'add',
      'origin',
      'https://user:secret-token@host.test/o/r.git',
    );
    const scope = lessonScope(a);
    expect(idSchema.safeParse(scope).success).toBe(true);
    expect(scope).toMatch(/^repo_[0-9a-f]{16}$/);
    expect(scope).not.toContain('secret');
  });
  it('is shared by clones with one origin and differs between remotes', () => {
    const a = init('a');
    const b = init('b');
    const c = init('c');
    git(a, 'remote', 'add', 'origin', 'git@host.test:o/r.git');
    git(b, 'remote', 'add', 'origin', 'https://HOST.test/o/r');
    git(c, 'remote', 'add', 'origin', 'https://host.test/o/other');
    expect(lessonScope(a)).toBe(lessonScope(b));
    expect(lessonScope(a)).not.toBe(lessonScope(c));
  });
  it('without a remote, is shared by worktrees and differs per repository', () => {
    const a = init('a');
    const b = init('b');
    git(a, 'worktree', 'add', '-q', '-b', 'side', join(root, 'side'));
    expect(lessonScope(join(root, 'side'))).toBe(lessonScope(a));
    expect(lessonScope(a)).not.toBe(lessonScope(b));
  });
  it('throws outside a Git repository', () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(() => lessonScope(plain)).toThrow();
  });
});
