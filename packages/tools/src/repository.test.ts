import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ToolRegistry } from './registry.ts';
import type { ToolContext } from './registry.ts';
import { gitInspect, repoSearch } from './repository.ts';

const TOKEN = 'ghp_' + 'r7'.repeat(18);
let root: string;
function write(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function git(...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}
let base: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-repo-tools-')));
  git('init', '-q');
  write(
    'src/fetch.ts',
    'export function fetchWithRetry(limit: number) {\n  return limit;\n}\n',
  );
  write('src/ui.ts', 'export const label = "retry";\n');
  write('.env', 'API=1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  base = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function call(tool: string, input: unknown) {
  const context: ToolContext = {
    projectId: 'project',
    taskId: 'task',
    attemptId: 'attempt',
    workerId: 'codex-1',
    permissionProfile: 'read-only',
    allowedTools: ['repo.search', 'git.inspect'],
    approvals: [],
    now: () => 1,
    workspace: { root, writablePaths: [], baseRevision: base },
  };
  return new ToolRegistry([repoSearch, gitInspect], {
    record: () => {},
  }).invoke({ tool, input }, context);
}

describe('repo.search', () => {
  it('returns ranked files with matching lines', async () => {
    const receipt = await call('repo.search', { query: 'retry limit' });
    expect(receipt.status).toBe('succeeded');
    const result = receipt.result as {
      matches: {
        path: string;
        matched: string[];
        lines: { line: number; text: string }[];
      }[];
    };
    expect(result.matches.map((match) => match.path)).toEqual([
      'src/fetch.ts',
      'src/ui.ts',
    ]);
    expect(result.matches[0]!.lines).toEqual([
      { line: 1, text: 'export function fetchWithRetry(limit: number) {' },
      { line: 2, text: 'return limit;' },
    ]);
    expect(JSON.stringify(result)).not.toContain('API=1');
  });
  it('bounds results', async () => {
    const receipt = await call('repo.search', { query: 'retry', limit: 1 });
    expect((receipt.result as { matches: unknown[] }).matches).toHaveLength(1);
    expect(
      (await call('repo.search', { query: 'retry', limit: 500 })).code,
    ).toBe('INVALID_INPUT');
  });
});

describe('git.inspect', () => {
  it('reports status without secret paths', async () => {
    write('src/fetch.ts', 'changed\n');
    write('src/new.ts', 'new\n');
    write('.env', 'API=2\n');
    const receipt = await call('git.inspect', { mode: 'status' });
    expect(receipt.result).toMatchObject({
      head: base,
      entries: [
        { status: ' M', path: 'src/fetch.ts' },
        { status: '??', path: 'src/new.ts' },
      ],
      omitted: [{ path: '.env', reason: 'secret_path' }],
    });
  });
  it('returns a diff that drops secret files and credential-bearing hunks', async () => {
    write('src/fetch.ts', 'export const changed = true;\n');
    write('src/ui.ts', 'export const token = "' + TOKEN + '";\n');
    write('.env', 'API=2\n');
    const receipt = await call('git.inspect', { mode: 'diff' });
    const result = receipt.result as {
      diff: string;
      files: { path: string; omitted?: string }[];
      truncated: boolean;
    };
    expect(result.diff).toContain('+export const changed = true;');
    expect(result.diff).not.toContain(TOKEN);
    expect(result.diff).not.toContain('API=2');
    expect(result.files).toEqual([
      { path: '.env', omitted: 'secret_path' },
      { path: 'src/fetch.ts' },
      { path: 'src/ui.ts', omitted: 'secret_content' },
    ]);
    expect(result.truncated).toBe(false);
  });
  it('reports head, branch and distance from the task base revision', async () => {
    write('src/fetch.ts', 'next\n');
    git('commit', '-q', '-am', 'next');
    const receipt = await call('git.inspect', { mode: 'base' });
    expect(receipt.result).toMatchObject({
      head: git('rev-parse', 'HEAD'),
      baseRevision: base,
      mergeBase: base,
      commitsSinceBase: 1,
    });
  });
  it('never runs repository-configured diff drivers or fsmonitor hooks', async () => {
    const marker = join(root, 'ran').replaceAll('\\', '/');
    const hook = join(root, 'hook.sh').replaceAll('\\', '/');
    writeFileSync(hook, '#!/bin/sh\necho ran > "' + marker + '"\n', {
      mode: 0o755,
    });
    git('config', 'core.fsmonitor', hook);
    git('config', 'diff.external', hook);
    write('.gitattributes', '*.ts diff=evil\n');
    git('config', 'diff.evil.textconv', hook);
    write('src/fetch.ts', 'changed\n');
    rmSync(marker, { force: true });
    for (const mode of ['status', 'diff', 'base'])
      expect((await call('git.inspect', { mode })).status).toBe('succeeded');
    expect(existsSync(marker)).toBe(false);
  });
});
