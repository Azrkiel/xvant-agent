// A real Git/worktree probe: retain path spellings when host setup disagrees.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { lessonScope } from '../packages/storage/src/lesson-scope.ts';

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=XVANT fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-preflight-')));
try {
  const repo = join(root, 'repo'),
    tree = join(root, 'tree');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', tree);
  const common = (cwd) => {
    const raw = git(cwd, 'rev-parse', '--git-common-dir');
    const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
    return {
      raw,
      real: realpathSync(absolute),
      native: realpathSync.native(absolute),
    };
  };
  const top = git(tree, 'rev-parse', '--show-toplevel');
  const report = {
    platform: process.platform,
    tempDirectory: tmpdir(),
    inheritedGitDir: Boolean(process.env.GIT_DIR),
    inheritedGitWorkTree: Boolean(process.env.GIT_WORK_TREE),
    tree: {
      registered: tree,
      real: realpathSync(tree),
      native: realpathSync.native(tree),
      gitTop: top,
      topReal: realpathSync(top),
      topNative: realpathSync.native(top),
    },
    repositoryCommon: common(repo),
    worktreeCommon: common(tree),
    repositoryScope: lessonScope(repo),
    worktreeScope: lessonScope(tree),
  };
  writeFileSync(
    '.artifacts/runner-preflight.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
  if (
    report.tree.real.toLowerCase() !== report.tree.topReal.toLowerCase() ||
    report.repositoryScope !== report.worktreeScope
  )
    throw new Error(
      'Git and Node disagree about canonical worktree identity; inspect runner-preflight.json',
    );
} finally {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
