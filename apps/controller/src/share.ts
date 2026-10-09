import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import {
  containsSecret,
  secretPath,
} from '../../../packages/context/src/secrets.ts';

export interface ShareOptions {
  /** A checkout whose current branch is the shared one. */
  repository: string;
  /** The branch everyone shares. Sharing refuses any other checked-out branch. */
  branch: string;
  remote?: string;
  /** Who the commits say they are from; defaults to Git's user.name, then the host name. */
  author?: string;
}
export interface ShareResult {
  /** Local changes committed in this cycle. */
  committed: string[];
  /** Commits taken from the remote. */
  pulled: number;
  pushed: boolean;
  /** Files both sides changed; the other side's version sits beside each as a copy. */
  conflicts: { path: string; copy: string | null }[];
  /** Changed files left out because they look like credentials. */
  skipped: string[];
  note?: string;
}

const MAX_SCAN_BYTES = 1024 * 1024;
function run(cwd: string, args: readonly string[]) {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    shell: false,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    // A sync loop must fail, not wait at a credential prompt nobody sees.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: String(result.stderr ?? ''),
  };
}
function git(cwd: string, args: readonly string[]): string {
  const result = run(cwd, args);
  if (!result.ok)
    throw new Error(
      'GIT_FAILED: ' + args[0] + ' ' + result.stderr.trim().slice(0, 300),
    );
  return result.stdout.toString('utf8').trim();
}
const lines = (text: string) => text.split('\n').filter(Boolean);

/** Whether a changed file may leave this machine. Deletions always may. */
function shareable(root: string, path: string): boolean {
  if (secretPath(path)) return false;
  const file = join(root, path);
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return true;
    return !containsSecret(readFileSync(file, 'utf8'));
  } catch {
    return true;
  }
}

/**
 * One sync cycle of a shared branch: commit local changes, take the remote's
 * commits, push. Git is the store, so every account that can push to the
 * remote can edit, from any device, and history keeps every version.
 *
 * Two people changing the same lines never lose work and never stop the
 * loop: this side's version stays in place and the other side's is written
 * beside it as `name.conflict-<commit>.ext` for a person to reconcile.
 * Files that look like credentials are never committed. Nothing is forced:
 * a rejected push is retried on the next cycle after merging.
 */
export function syncOnce(options: ShareOptions): ShareResult {
  const root = options.repository;
  const remote = options.remote ?? 'origin';
  const branch = options.branch;
  if (!isAbsolute(root)) throw new Error('INVALID_INPUT');
  if (!/^[A-Za-z0-9._/-]{1,128}$/.test(branch) || branch.includes('..'))
    throw new Error('INVALID_INPUT');
  const head = run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const current = head.stdout.toString('utf8').trim();
  if (!head.ok || current !== branch)
    throw new Error(
      'WRONG_BRANCH: the checkout is on ' +
        (current || 'no branch') +
        ', not ' +
        branch,
    );
  const gitDir = git(root, ['rev-parse', '--absolute-git-dir']);
  if (
    ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'].some(
      (name) => existsSync(join(gitDir, name)),
    )
  )
    throw new Error('MERGE_IN_PROGRESS: finish or abort it first');
  const result: ShareResult = {
    committed: [],
    pulled: 0,
    pushed: false,
    conflicts: [],
    skipped: [],
  };

  // 1. Commit local changes, leaving out anything that looks like a credential.
  const status = run(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all',
  ]);
  if (!status.ok) throw new Error('GIT_FAILED: status ' + status.stderr.trim());
  const changed = status.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  const staging: string[] = [];
  for (const path of changed)
    (shareable(root, path) ? staging : result.skipped).push(path);
  for (let i = 0; i < staging.length; i += 100)
    git(root, ['add', '-A', '--', ...staging.slice(i, i + 100)]);
  if (!run(root, ['diff', '--cached', '--quiet']).ok) {
    const who =
      options.author ??
      (run(root, ['config', 'user.name']).stdout.toString('utf8').trim() ||
        hostname());
    git(root, [
      'commit',
      '-m',
      'share: ' + staging.length + ' file(s) from ' + who,
    ]);
    result.committed = staging;
  }

  // 2. Take the remote's commits.
  const tracking = 'refs/remotes/' + remote + '/' + branch;
  const listed = run(root, ['ls-remote', '--heads', remote, branch]);
  if (!listed.ok) {
    result.note = 'Remote unreachable: ' + listed.stderr.trim().slice(0, 200);
    return result;
  }
  const published = listed.stdout.length > 0;
  if (published) {
    git(root, ['fetch', remote, '+refs/heads/' + branch + ':' + tracking]);
    result.pulled = Number(
      git(root, ['rev-list', '--count', 'HEAD..' + tracking]),
    );
    if (result.pulled) {
      const theirs = git(root, ['rev-parse', '--short', tracking]);
      const merge = run(root, ['merge', '--no-edit', tracking]);
      if (!merge.ok) {
        const unmerged = lines(
          git(root, ['diff', '--name-only', '--diff-filter=U']),
        );
        if (!unmerged.length) {
          run(root, ['merge', '--abort']);
          throw new Error(
            'GIT_FAILED: merge ' + merge.stderr.trim().slice(0, 300),
          );
        }
        for (const path of unmerged) {
          const other = run(root, ['show', 'MERGE_HEAD:' + path]);
          const mine = run(root, ['checkout', '--ours', '--', path]);
          let copy: string | null = null;
          if (other.ok && mine.ok) {
            // Both changed it: this side stays, the other side lands beside it.
            const ext = extname(path);
            copy =
              path.slice(0, path.length - ext.length) +
              '.conflict-' +
              theirs +
              ext;
            writeFileSync(join(root, copy), other.stdout);
            git(root, ['add', '--', path, copy]);
          } else if (other.ok) {
            // Deleted here, changed there: the change wins over the deletion.
            git(root, ['checkout', '--theirs', '--', path]);
            git(root, ['add', '--', path]);
          } else git(root, ['add', '--', path]);
          result.conflicts.push({ path, copy });
        }
        git(root, ['commit', '--no-edit']);
      }
    }
  }

  // 3. Publish. A push that loses a race is merged and retried next cycle.
  const ahead = published
    ? Number(git(root, ['rev-list', '--count', tracking + '..HEAD']))
    : 1;
  if (ahead) {
    const push = run(root, ['push', remote, 'HEAD:refs/heads/' + branch]);
    result.pushed = push.ok;
    if (!push.ok)
      result.note =
        'Push not accepted; it is retried on the next cycle: ' +
        push.stderr.trim().split('\n').at(-1)!.slice(0, 200);
  }
  return result;
}

/** One line per thing that happened in a cycle; empty when nothing did. */
export function describeSync(result: ShareResult): string[] {
  const out: string[] = [];
  if (result.committed.length)
    out.push(
      'sent     ' +
        result.committed.slice(0, 5).join(', ') +
        (result.committed.length > 5
          ? ' and ' + (result.committed.length - 5) + ' more'
          : ''),
    );
  if (result.pulled) out.push('received ' + result.pulled + ' commit(s)');
  for (const c of result.conflicts)
    out.push(
      'conflict ' +
        c.path +
        (c.copy ? ': the other version is in ' + c.copy : ''),
    );
  for (const path of result.skipped)
    out.push('skipped  ' + path + ' (looks like a credential)');
  if (result.note) out.push('note     ' + result.note);
  return out;
}
