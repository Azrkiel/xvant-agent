import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

function git(cwd: string, args: readonly string[]): string | null {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * A remote URL reduced to the repository it names: no credentials, no
 * trailing `.git` or `/`, lowercase host, and the scp-like form
 * (`git@host:a/b`) equal to the URL form (`https://host/a/b`).
 */
export function normalizeRemoteUrl(url: string): string {
  const raw = url.trim();
  let host: string;
  let path: string;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)(\/.*)?$/.exec(raw);
  if (scheme) {
    host = scheme[1]!;
    path = scheme[2] ?? '';
  } else {
    const scp = /^(?:[^@/\:]+@)?([^/\:]+):(?!\/\/)(.*)$/.exec(raw);
    // A Windows drive path (C:\repo) or plain local path is not a host.
    if (!scp || /^[A-Za-z]$/.test(scp[1]!)) {
      host = '';
      path = raw.replaceAll('\\', '/');
    } else {
      host = scp[1]!;
      path = '/' + scp[2]!;
    }
  }
  // Credentials carry no identity and must never reach the scope.
  host = host.slice(host.lastIndexOf('@') + 1).toLowerCase();
  path = path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
  if (host && !path.startsWith('/')) path = '/' + path;
  return host + path;
}

/**
 * A stable lesson scope for a repository, usable as a project id. Clones
 * with the same `origin` share one; without a remote, every worktree of one
 * repository does. Only a hash is returned, since a remote URL may hold
 * credentials. Throws when `repository` is not a Git repository.
 */
export function lessonScope(repository: string): string {
  const remote = git(repository, ['config', '--get', 'remote.origin.url']);
  let basis: string;
  if (remote) basis = 'remote:' + normalizeRemoteUrl(remote);
  else {
    const common = git(repository, ['rev-parse', '--git-common-dir']);
    if (!common) throw new Error('NOT_A_GIT_REPOSITORY');
    const path = isAbsolute(common) ? common : resolve(repository, common);
    let real = realpathSync(path);
    if (process.platform === 'win32') real = real.toLowerCase();
    basis = 'path:' + real;
  }
  return (
    'repo_' + createHash('sha256').update(basis).digest('hex').slice(0, 16)
  );
}
