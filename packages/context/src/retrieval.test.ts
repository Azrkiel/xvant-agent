import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  collectRepository,
  repositoryContextItems,
  searchRepository,
} from './retrieval.ts';
import { buildContextPacket } from './packet.ts';

// Sentinels are assembled at runtime so this source never holds a key-shaped literal.
const AWS_SENTINEL = 'AKIA' + 'Q7'.repeat(8);
const PEM_SENTINEL = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nabc\n';
const GH_SENTINEL = 'ghp_' + 'x1'.repeat(18);
let root: string;
function write(path: string, content: string | Buffer) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function git(...args: string[]) {
  execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd: root,
    stdio: 'ignore',
  });
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-retrieval-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('repository collection', () => {
  it('honors git ignore rules and hashes file content', () => {
    git('init', '-q');
    write('.gitignore', 'dist/\n*.log\n');
    write('src/fetch.ts', 'export function fetchWithRetry() {}\n');
    write('dist/bundle.js', 'compiled');
    write('debug.log', 'noise');
    write('notes/untracked.md', 'retry notes');
    const result = collectRepository(root);
    expect(result.source).toBe('git');
    expect(result.files.map((file) => file.path)).toEqual([
      '.gitignore',
      'notes/untracked.md',
      'src/fetch.ts',
    ]);
    const fetch = result.files.find((file) => file.path === 'src/fetch.ts')!;
    expect(fetch.hash).toBe(
      createHash('sha256').update(fetch.content).digest('hex'),
    );
    expect(fetch.bytes).toBe(Buffer.byteLength(fetch.content));
  });
  it('walks non-git folders and skips dependency and VCS directories', () => {
    write('app.ts', 'main');
    write('node_modules/pkg/index.js', 'dependency');
    write('.git/config', 'fake');
    const result = collectRepository(root);
    expect(result.source).toBe('walk');
    expect(result.files.map((file) => file.path)).toEqual(['app.ts']);
  });
  it('excludes secret paths and secret-bearing content without reading them into results', () => {
    write('.env', 'API_TOKEN=plain');
    write('.env.production', 'x=1');
    write('.env.example', 'API_TOKEN=');
    write('certs/server.pem', 'cert');
    write('keys/id_ed25519', 'key');
    write('.npmrc', '//registry/:_authToken=t');
    write('config/aws.ts', 'const key = "' + AWS_SENTINEL + '";');
    write('config/pem.txt', PEM_SENTINEL);
    write('config/gh.ts', 'token=' + GH_SENTINEL);
    write('ok.ts', 'fine');
    const result = collectRepository(root);
    expect(result.files.map((file) => file.path)).toEqual([
      '.env.example',
      'ok.ts',
    ]);
    const reasons = Object.fromEntries(
      result.omitted.map((entry) => [entry.path, entry.reason]),
    );
    expect(reasons).toEqual({
      '.env': 'secret_path',
      '.env.production': 'secret_path',
      '.npmrc': 'secret_path',
      'certs/server.pem': 'secret_path',
      'keys/id_ed25519': 'secret_path',
      'config/aws.ts': 'secret_content',
      'config/pem.txt': 'secret_content',
      'config/gh.ts': 'secret_content',
    });
    const serialized = JSON.stringify(result);
    for (const sentinel of [AWS_SENTINEL, GH_SENTINEL, 'PRIVATE KEY'])
      expect(serialized).not.toContain(sentinel);
  });
  it('omits binary, invalid UTF-8, and oversized files', () => {
    write('image.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    write('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    write('big.txt', 'b'.repeat(2048));
    write('small.txt', 'fine');
    const result = collectRepository(root, { maxFileBytes: 1024 });
    expect(result.files.map((file) => file.path)).toEqual(['small.txt']);
    expect(result.omitted).toEqual([
      { path: 'big.txt', reason: 'too_large' },
      { path: 'image.png', reason: 'binary' },
      { path: 'latin1.txt', reason: 'binary' },
    ]);
  });
  it('stops at file and byte limits and reports the remainder', () => {
    for (const name of ['a', 'b', 'c', 'd']) write(name + '.txt', name);
    const byCount = collectRepository(root, { maxFiles: 2 });
    expect(byCount.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt']);
    expect(byCount.omitted).toEqual([
      { path: 'c.txt', reason: 'limit' },
      { path: 'd.txt', reason: 'limit' },
    ]);
    const byBytes = collectRepository(root, { maxTotalBytes: 3 });
    expect(byBytes.files.map((file) => file.path)).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
    ]);
  });
  it.each(['walk', 'git'] as const)(
    'rejects links instead of following them out of the root (%s)',
    (mode) => {
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'xvant-outside-')),
      );
      try {
        if (mode === 'git') git('init', '-q');
        writeFileSync(join(outside, 'secret.txt'), 'outside data');
        write('inside.txt', 'inside');
        // Junctions need no privilege on Windows; elsewhere this is a symlink.
        symlinkSync(outside, join(root, 'escape'), 'junction');
        const result = collectRepository(root);
        expect(result.source).toBe(mode);
        expect(result.files.map((file) => file.path)).toEqual(['inside.txt']);
        expect(JSON.stringify(result)).not.toContain('outside data');
        expect(result.omitted.map((entry) => entry.reason)).toEqual(
          result.omitted.map(() => 'unsafe_path'),
        );
        expect(result.omitted.length).toBeGreaterThan(0);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
  it('requires a canonical absolute directory', () => {
    expect(() => collectRepository('relative/path')).toThrow('INVALID_INPUT');
    expect(() => collectRepository(join(root, 'missing'))).toThrow();
    expect(() => collectRepository(root, { maxFiles: 0 })).toThrow(
      'INVALID_INPUT',
    );
  });
  it('does not run repository-configured fsmonitor commands', () => {
    git('init', '-q');
    const marker = join(root, 'fsmonitor-ran');
    const hook = join(root, 'hook.sh').replaceAll('\\', '/');
    writeFileSync(
      hook,
      '#!/bin/sh\necho ran > "' + marker.replaceAll('\\', '/') + '"\n',
      { mode: 0o755 },
    );
    write('a.ts', 'a');
    git('add', 'a.ts');
    git('config', 'core.fsmonitor', hook);
    rmSync(marker, { force: true });
    collectRepository(root);
    expect(() => realpathSync(marker)).toThrow();
  });
});

describe('repository search', () => {
  const files = () => {
    write(
      'src/net/fetchWithRetry.ts',
      'export function fetchWithRetry(limit) { return limit; }',
    );
    write('src/ui/button.ts', 'export const Button = () => "retry";');
    write('docs/readme.md', 'Nothing relevant here.');
    return collectRepository(root).files;
  };
  it('ranks path and symbol matches above incidental body matches', () => {
    const results = searchRepository(files(), 'retry limit for fetch');
    expect(results.map((result) => result.path)).toEqual([
      'src/net/fetchWithRetry.ts',
      'src/ui/button.ts',
    ]);
    expect(results[0]!.matched).toEqual(['fetch', 'limit', 'retry']);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });
  it('treats query syntax as data and bounds the result count', () => {
    const indexed = files();
    expect(searchRepository(indexed, '" OR * NEAR( ) -- ;')).toEqual([]);
    expect(searchRepository(indexed, 'retry', { limit: 1 })).toHaveLength(1);
    expect(searchRepository(indexed, '')).toEqual([]);
  });
  it('produces sourced context items the packet builder accepts', () => {
    const indexed = files();
    const results = searchRepository(indexed, 'retry limit');
    const items = repositoryContextItems({
      projectId: 'project',
      revision: 'e'.repeat(40),
      files: indexed,
      results,
    });
    expect(items[0]).toMatchObject({
      kind: 'file',
      required: false,
      priority: 100,
      provenance: {
        source: 'repository',
        projectId: 'project',
        ref: 'src/net/fetchWithRetry.ts',
        revision: 'e'.repeat(40),
      },
    });
    expect(items[1]!.priority).toBeLessThan(100);
    expect(items[1]!.priority).toBeGreaterThanOrEqual(1);
    const packet = buildContextPacket({
      projectId: 'project',
      taskId: 'task',
      objective: 'Fix retry limit',
      acceptanceCriteria: ['Tests pass'],
      baseRevision: 'e'.repeat(40),
      recipient: { workerId: 'claude-1', role: 'worker' },
      ownership: { writablePaths: ['src/net/fetchWithRetry.ts'] },
      policy: { permissionProfile: 'trusted-local', allowedTools: [] },
      skills: [],
      budget: { maxTokens: 4096 },
      items,
    });
    expect(packet.items).toHaveLength(2);
  });
});
