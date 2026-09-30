import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree } from './git-workspace.ts';

function fail(code: string): never {
  throw new Error(code);
}
const IDENTITY = [
  '-c',
  'user.name=XVANT',
  '-c',
  'user.email=xvant@local.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.quotepath=off',
];
function git(cwd: string, args: readonly string[], allowFailure = false) {
  const result = spawnSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure)
    fail('GIT_FAILED: ' + args[0] + ' ' + result.stderr.slice(0, 200));
  return result;
}

export type IntegrationResult =
  | { status: 'applied'; commit: string; files: string[] }
  | { status: 'empty'; commit: string }
  | { status: 'conflict'; files: string[] };

/**
 * The one writer of a root task's integration branch. Patches are applied
 * one at a time with a three-way merge against the objects the worker's
 * worktree recorded; a conflict leaves the branch at its previous commit and
 * is reported, never forced. This worktree belongs to XVANT, so restoring it
 * after a failed apply cannot touch user work.
 */
export class IntegrationBranch {
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  #busy = false;
  private constructor(path: string, branch: string, baseCommit: string) {
    this.path = path;
    this.branch = branch;
    this.baseCommit = baseCommit;
  }
  static create(
    repository: string,
    baseRevision: string,
    path: string,
    branch: string,
  ): IntegrationBranch {
    const tree = createWorktree(repository, baseRevision, path, branch);
    return new IntegrationBranch(tree.path, tree.branch, tree.baseCommit);
  }
  /** Reattach to an existing integration worktree after a restart. */
  static open(
    path: string,
    branch: string,
    baseCommit: string,
  ): IntegrationBranch {
    const current = git(path, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]).stdout.trim();
    if (current !== branch) fail('CONFLICT');
    if (git(path, ['status', '--porcelain']).stdout.trim())
      fail('WORKSPACE_CHANGED');
    return new IntegrationBranch(path, branch, baseCommit);
  }
  head(): string {
    return git(this.path, ['rev-parse', 'HEAD']).stdout.trim();
  }
  apply(patch: Buffer, message: string): IntegrationResult {
    if (this.#busy) fail('WORKER_BUSY');
    this.#busy = true;
    const file = join(
      tmpdir(),
      'xvant-patch-' + randomBytes(12).toString('hex'),
    );
    try {
      if (git(this.path, ['status', '--porcelain']).stdout.trim())
        fail('WORKSPACE_CHANGED');
      if (!patch.length) return { status: 'empty', commit: this.head() };
      writeFileSync(file, patch, { flag: 'wx' });
      const applied = git(
        this.path,
        ['apply', '--3way', '--index', '--whitespace=nowarn', file],
        true,
      );
      if (applied.status !== 0) {
        const conflicted = git(
          this.path,
          ['diff', '--name-only', '--diff-filter=U'],
          true,
        )
          .stdout.split('\n')
          .filter(Boolean);
        git(this.path, ['reset', '--hard', '-q', 'HEAD']);
        git(this.path, ['clean', '-fdq']);
        return { status: 'conflict', files: conflicted };
      }
      const files = git(this.path, ['diff', '--cached', '--name-only'])
        .stdout.split('\n')
        .filter(Boolean);
      if (!files.length) return { status: 'empty', commit: this.head() };
      git(this.path, ['commit', '-q', '--no-verify', '-m', message]);
      return { status: 'applied', commit: this.head(), files };
    } finally {
      rmSync(file, { force: true });
      this.#busy = false;
    }
  }
  /** The combined change from the base, for review. */
  diff(): string {
    return git(this.path, ['diff', '--binary', this.baseCommit, 'HEAD']).stdout;
  }
}
