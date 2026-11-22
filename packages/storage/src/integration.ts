import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
function git(
  cwd: string,
  args: readonly string[],
  allowFailure = false,
  env?: NodeJS.ProcessEnv,
) {
  const result = spawnSync('git', [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  if (result.status !== 0 && !allowFailure)
    fail(
      'GIT_FAILED: ' +
        args[0] +
        ' ' +
        String(result.stderr ?? '').slice(0, 200),
    );
  return result;
}

function gitDirectory(cwd: string) {
  return realpathSync(
    git(cwd, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]).stdout.trim(),
  );
}

function ownershipMarker(cwd: string): string {
  return join(
    realpathSync(git(cwd, ['rev-parse', '--absolute-git-dir']).stdout.trim()),
    'xvant-initialized',
  );
}

function requireClean(cwd: string) {
  if (
    git(
      cwd,
      [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ],
      false,
      { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    ).stdout.trim()
  )
    fail('WORKSPACE_CHANGED');
}

function commitMessage(message: string, dispatchId?: string) {
  return dispatchId ? message + '\n\nXVANT-Dispatch: ' + dispatchId : message;
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
    dispatchId?: string,
  ): IntegrationBranch {
    const tree = createWorktree(repository, baseRevision, path, branch);
    if (dispatchId)
      writeFileSync(ownershipMarker(tree.path), dispatchId, {
        flag: 'wx',
        mode: 0o600,
      });
    return new IntegrationBranch(tree.path, tree.branch, tree.baseCommit);
  }
  /** Reattach to an existing integration worktree after a restart. */
  static open(
    path: string,
    branch: string,
    baseCommit: string,
    expected?: { repository: string; head: string },
  ): IntegrationBranch {
    if (expected) {
      if (
        realpathSync(path) !== path ||
        realpathSync(
          git(path, ['rev-parse', '--show-toplevel']).stdout.trim(),
        ) !== path ||
        gitDirectory(path) !== gitDirectory(expected.repository) ||
        git(path, ['rev-parse', 'HEAD']).stdout.trim() !== expected.head
      )
        fail('INTEGRATION_CHANGED');
    }
    const current = git(path, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]).stdout.trim();
    if (current !== branch) fail('CONFLICT');
    requireClean(path);
    return new IntegrationBranch(path, branch, baseCommit);
  }

  static inspect(
    repository: string,
    path: string,
    branch: string,
    baseCommit: string,
    dispatchId?: string,
  ): IntegrationBranch {
    if (realpathSync(path) !== path) fail('INTEGRATION_CHANGED');
    const head = git(path, ['rev-parse', 'HEAD']).stdout.trim();
    const checkout = IntegrationBranch.open(path, branch, baseCommit, {
      repository,
      head,
    });
    const worktrees = git(repository, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ]).stdout.split('\0\0');
    if (
      !worktrees.some((worktree) => {
        const [directory, revision, ref] = worktree.split('\0');
        return (
          revision === 'HEAD ' + head &&
          ref === 'branch refs/heads/' + branch &&
          directory?.startsWith('worktree ') &&
          realpathSync(directory.slice('worktree '.length)) === path
        );
      })
    )
      fail('INTEGRATION_WORKTREE_UNREGISTERED');
    if (
      dispatchId &&
      readFileSync(ownershipMarker(path), 'utf8') !== dispatchId
    )
      fail('INTEGRATION_OWNERSHIP_UNPROVEN');
    return checkout;
  }
  head(): string {
    return git(this.path, ['rev-parse', 'HEAD']).stdout.trim();
  }
  apply(
    patch: Buffer,
    message: string,
    dispatchId?: string,
    expectedHead?: string,
  ): IntegrationResult {
    if (this.#busy) fail('WORKER_BUSY');
    this.#busy = true;
    const file = join(
      tmpdir(),
      'xvant-patch-' + randomBytes(12).toString('hex'),
    );
    try {
      requireClean(this.path);
      if (expectedHead !== undefined && this.head() !== expectedHead)
        fail('INTEGRATION_CHANGED');
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
      git(this.path, [
        'commit',
        '-q',
        '--no-verify',
        ...(dispatchId ? ['--cleanup=verbatim'] : []),
        '-m',
        commitMessage(message, dispatchId),
      ]);
      return { status: 'applied', commit: this.head(), files };
    } finally {
      rmSync(file, { force: true });
      this.#busy = false;
    }
  }

  /** Verify the committed tree by replaying the saved patch into a disposable index. */
  recoverApply(
    before: string,
    patch: Buffer,
    message: string,
    dispatchId: string,
  ) {
    const head = this.head();
    if (head === before) {
      if (!patch.length)
        return {
          result: { status: 'empty' as const, commit: head },
          tree: null,
        };
      fail('INTEGRATION_COMMIT_MISSING');
    }
    const [parents, tree, ...body] = git(this.path, [
      'show',
      '-s',
      '--format=%P%n%T%n%B',
      head,
    ])
      .stdout.trimEnd()
      .split('\n');
    if (
      !patch.length ||
      parents !== before ||
      body.join('\n') !== commitMessage(message, dispatchId)
    )
      fail('INTEGRATION_CHANGED');
    const scratch = mkdtempSync(join(tmpdir(), 'xvant-recovery-'));
    try {
      const file = join(scratch, 'patch');
      writeFileSync(file, patch, { flag: 'wx', mode: 0o600 });
      const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
      git(this.path, ['read-tree', before], false, env);
      git(
        this.path,
        ['apply', '--3way', '--cached', '--whitespace=nowarn', file],
        false,
        env,
      );
      if (git(this.path, ['write-tree'], false, env).stdout.trim() !== tree)
        fail('INTEGRATION_PATCH_MISMATCH');
      requireClean(this.path);
      if (this.head() !== head) fail('INTEGRATION_CHANGED');
      const files = git(this.path, ['diff', '--name-only', before, head])
        .stdout.split('\n')
        .filter(Boolean);
      return {
        result: { status: 'applied' as const, commit: head, files },
        tree,
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  /** The combined change from the base, for review. */
  diff(): string {
    return git(this.path, ['diff', '--binary', this.baseCommit, 'HEAD']).stdout;
  }
}
