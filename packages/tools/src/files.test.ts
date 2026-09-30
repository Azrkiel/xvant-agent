import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ToolRegistry } from './registry.ts';
import type { ToolContext } from './registry.ts';
import { fileApplyPatch, fileRead } from './files.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
let root: string;
let outside: string;
function write(path: string, content: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
const read = (path: string) => readFileSync(join(root, path), 'utf8');
function setup(writablePaths: string[] = ['src'], withWorkspace = true) {
  const registry = new ToolRegistry([fileRead, fileApplyPatch], {
    record: () => {},
  });
  const context: ToolContext = {
    projectId: 'project',
    taskId: 'task',
    attemptId: 'attempt',
    workerId: 'claude-1',
    permissionProfile: 'trusted-local',
    allowedTools: ['file.read', 'file.apply_patch'],
    approvals: [],
    now: () => 1,
    ...(withWorkspace ? { workspace: { root, writablePaths } } : {}),
  };
  return {
    call: (tool: string, input: unknown, extra: Partial<ToolContext> = {}) =>
      registry.invoke({ tool, input }, { ...context, ...extra }),
  };
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-files-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-outside-')));
  write('src/a.ts', 'one\ntwo\nthree\nfour\n');
  write('README.md', 'readme\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('file.read', () => {
  it('returns a line range with the whole-file hash', async () => {
    const { call } = setup();
    expect(
      await call('file.read', { path: 'src/a.ts', startLine: 2, endLine: 3 }),
    ).toMatchObject({
      status: 'succeeded',
      result: {
        path: 'src/a.ts',
        hash: sha('one\ntwo\nthree\nfour\n'),
        totalLines: 4,
        startLine: 2,
        endLine: 3,
        content: 'two\nthree',
      },
    });
    expect(
      (await call('file.read', { path: 'src/a.ts' })).result,
    ).toMatchObject({
      startLine: 1,
      endLine: 4,
      content: 'one\ntwo\nthree\nfour',
    });
  });
  it.each([
    ['../escape.txt', 'PATH_DENIED'],
    ['.env', 'PATH_DENIED'],
    ['.git/config', 'PATH_DENIED'],
    ['missing.ts', 'NOT_FOUND'],
    ['src', 'PATH_DENIED'],
  ])('refuses %s with %s', async (path, code) => {
    write('.env', 'API_TOKEN=x');
    write('.git/config', '[core]');
    const { call } = setup();
    const receipt = await call('file.read', { path });
    expect(receipt.code).toBe(code);
  });
  it('refuses binary and credential-bearing files and junction escapes', async () => {
    write('bin.dat', Buffer.from([0, 1, 2]));
    write('src/keys.ts', 'const k = "' + 'AKIA' + 'Q2'.repeat(8) + '";');
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    symlinkSync(outside, join(root, 'linked'), 'junction');
    const { call } = setup();
    expect((await call('file.read', { path: 'bin.dat' })).code).toBe(
      'INVALID_INPUT',
    );
    expect((await call('file.read', { path: 'src/keys.ts' })).code).toBe(
      'PATH_DENIED',
    );
    const escaped = await call('file.read', { path: 'linked/secret.txt' });
    expect(escaped.code).toBe('PATH_DENIED');
    expect(JSON.stringify(escaped)).not.toContain('outside');
  });
  it('requires a workspace in the host context', async () => {
    const { call } = setup(['src'], false);
    expect((await call('file.read', { path: 'src/a.ts' })).code).toBe(
      'CAPABILITY_UNSUPPORTED',
    );
  });
});

describe('file.apply_patch', () => {
  it('applies replacements, writes and deletes against expected hashes', async () => {
    write('src/old.ts', 'legacy\n');
    const { call } = setup();
    const receipt = await call('file.apply_patch', {
      edits: [
        {
          path: 'src/a.ts',
          expectedHash: sha('one\ntwo\nthree\nfour\n'),
          replacements: [{ find: 'two', replace: '2' }],
        },
        { path: 'src/new/b.ts', expectedHash: null, content: 'new file\n' },
        { path: 'src/old.ts', expectedHash: sha('legacy\n'), delete: true },
      ],
    });
    expect(receipt).toMatchObject({
      status: 'succeeded',
      result: {
        files: [
          {
            path: 'src/a.ts',
            before: sha('one\ntwo\nthree\nfour\n'),
            after: sha('one\n2\nthree\nfour\n'),
          },
          { path: 'src/new/b.ts', before: null, after: sha('new file\n') },
          { path: 'src/old.ts', before: sha('legacy\n'), after: null },
        ],
      },
    });
    expect(read('src/a.ts')).toBe('one\n2\nthree\nfour\n');
    expect(read('src/new/b.ts')).toBe('new file\n');
    expect(existsSync(join(root, 'src/old.ts'))).toBe(false);
  });
  it('rejects the whole patch when any file is stale, leaving every file untouched', async () => {
    write('src/c.ts', 'c\n');
    const { call } = setup();
    const receipt = await call('file.apply_patch', {
      edits: [
        { path: 'src/c.ts', expectedHash: sha('c\n'), content: 'C\n' },
        { path: 'src/a.ts', expectedHash: sha('stale'), content: 'x' },
      ],
    });
    expect(receipt).toMatchObject({ status: 'failed', code: 'STALE_EVIDENCE' });
    expect(read('src/c.ts')).toBe('c\n');
    expect(
      (
        await call('file.apply_patch', {
          edits: [{ path: 'src/a.ts', expectedHash: null, content: 'clobber' }],
        })
      ).code,
    ).toBe('STALE_EVIDENCE');
  });
  it.each([
    ['README.md', 'PATH_DENIED'],
    ['srcfake/a.ts', 'PATH_DENIED'],
    ['src/../README.md', 'PATH_DENIED'],
    ['src/.env', 'PATH_DENIED'],
    ['src/.git/hooks/pre-commit', 'PATH_DENIED'],
  ])('refuses out-of-scope path %s', async (path, code) => {
    const { call } = setup();
    const receipt = await call('file.apply_patch', {
      edits: [{ path, expectedHash: null, content: 'x' }],
    });
    expect(receipt.code).toBe(code);
    expect(read('README.md')).toBe('readme\n');
  });
  it('refuses writes through a junction inside the owned scope', async () => {
    symlinkSync(outside, join(root, 'src', 'out'), 'junction');
    const { call } = setup();
    const receipt = await call('file.apply_patch', {
      edits: [{ path: 'src/out/x.ts', expectedHash: null, content: 'x' }],
    });
    expect(receipt.code).toBe('PATH_DENIED');
    expect(existsSync(join(outside, 'x.ts'))).toBe(false);
  });
  it('requires each replacement to match exactly once and paths to be unique', async () => {
    write('src/d.ts', 'x x\n');
    const { call } = setup();
    const hash = sha('x x\n');
    for (const replacements of [
      [{ find: 'x', replace: 'y' }],
      [{ find: 'missing', replace: 'y' }],
    ])
      expect(
        (
          await call('file.apply_patch', {
            edits: [{ path: 'src/d.ts', expectedHash: hash, replacements }],
          })
        ).code,
      ).toBe('CONFLICT');
    expect(
      (
        await call('file.apply_patch', {
          edits: [
            { path: 'src/d.ts', expectedHash: hash, content: 'a' },
            { path: 'src/d.ts', expectedHash: hash, content: 'b' },
          ],
        })
      ).code,
    ).toBe('INVALID_INPUT');
    expect(read('src/d.ts')).toBe('x x\n');
  });
  it('is denied under a read-only profile', async () => {
    const { call } = setup();
    expect(
      (
        await call(
          'file.apply_patch',
          { edits: [{ path: 'src/z.ts', expectedHash: null, content: 'z' }] },
          { permissionProfile: 'read-only' },
        )
      ).code,
    ).toBe('POLICY_DENIED');
  });
});
