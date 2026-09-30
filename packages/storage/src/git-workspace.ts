import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ArtifactStore, safePath } from './artifacts.ts';
import type { WorkspaceSnapshot } from './workspace.ts';

function fail(code: string): never {
  throw new Error(code);
}
function git(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
): Buffer {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    shell: false,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (result.status !== 0)
    fail('GIT_FAILED: ' + args[0] + ' ' + String(result.stderr).slice(0, 200));
  return result.stdout;
}
const text = (cwd: string, args: readonly string[]) =>
  git(cwd, args).toString('utf8').trim();

/**
 * A writer's isolated Git worktree on a new branch at a recorded base commit.
 * Never resets, stashes or touches the source checkout's working tree.
 */
export function createWorktree(
  repository: string,
  baseRevision: string,
  path: string,
  branch: string,
): { path: string; baseCommit: string; branch: string } {
  if (!isAbsolute(repository) || !isAbsolute(path)) fail('INVALID_INPUT');
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(branch) || branch.includes('..'))
    fail('INVALID_INPUT');
  const baseCommit = text(repository, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    baseRevision + '^{commit}',
  ]);
  git(repository, ['worktree', 'add', '-b', branch, resolve(path), baseCommit]);
  return { path: realpathSync(resolve(path)), baseCommit, branch };
}

/** Remove a worktree XVANT created. The branch and its commits are kept. */
export function removeWorktree(repository: string, path: string): void {
  git(repository, ['worktree', 'remove', '--force', resolve(path)]);
}

/**
 * Content evidence for a Git worktree of any size: the working tree (tracked
 * plus untracked, excluding ignored files) as a Git tree, and the binary patch
 * from the base commit to it. Uses a private index, so the worker's index,
 * HEAD and files are untouched and its own commits do not change the result.
 */
export function captureGitWorkspace(
  root: string,
  baseCommit: string,
  objects: ArtifactStore,
): WorkspaceSnapshot {
  if (!isAbsolute(root)) fail('INVALID_INPUT');
  const absolute = safePath(root);
  if (realpathSync(absolute) !== absolute) fail('UNSAFE_PATH');
  let top: string;
  try {
    top = realpathSync(text(absolute, ['rev-parse', '--show-toplevel']));
  } catch {
    fail('UNSAFE_PATH');
  }
  if (top.toLowerCase() !== absolute.toLowerCase()) fail('UNSAFE_PATH');
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(baseCommit)) fail('INVALID_INPUT');
  text(absolute, ['cat-file', '-e', baseCommit + '^{commit}']);
  const index = join(
    tmpdir(),
    'xvant-index-' + randomBytes(12).toString('hex'),
  );
  let gitTree: string;
  try {
    const env = { GIT_INDEX_FILE: index };
    git(absolute, ['read-tree', baseCommit], env);
    git(absolute, ['add', '-A', '--', '.'], env);
    gitTree = git(absolute, ['write-tree'], env).toString().trim();
  } finally {
    rmSync(index, { force: true });
    rmSync(index + '.lock', { force: true });
  }
  const patchBytes = git(absolute, [
    'diff',
    '--binary',
    '--full-index',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    baseCommit,
    gitTree,
  ]);
  const files = git(absolute, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    baseCommit,
    gitTree,
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .reduce<{ path: string; status: string }[]>((list, value, i, all) => {
      if (i % 2 === 0) list.push({ path: all[i + 1]!, status: value });
      return list;
    }, [])
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const patch = objects.put(patchBytes);
  const treeHash = objects.put(
    Buffer.from(
      JSON.stringify({
        version: 2,
        kind: 'git',
        baseCommit,
        gitTree,
        patch,
        patchBytes: patchBytes.length,
        files,
      }),
    ),
  );
  const hashes = [...new Set([treeHash, patch])].sort();
  const artifactSetHash = objects.put(
    Buffer.from(JSON.stringify({ version: 1, hashes })),
  );
  return {
    treeHash,
    artifactSetHash,
    artifactHashes: [...new Set([...hashes, artifactSetHash])].sort(),
    workspaceRootHash: createHash('sha256').update(absolute).digest('hex'),
  };
}
