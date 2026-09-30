import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidatePaths, discoverRuntime } from './discover.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-discover-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const exe = (name: string) =>
  process.platform === 'win32' ? name + '.exe' : name;
const touch = (...parts: string[]) => {
  mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...parts), '');
  return join(root, ...parts);
};

it('finds runtimes outside PATH at their usual install locations', () => {
  const env = { PATH: '', USERPROFILE: root, LOCALAPPDATA: join(root, 'L') };
  const codex = touch('L', 'OpenAI', 'Codex', 'bin', 'abc', exe('codex'));
  const claude = touch('.local', 'bin', exe('claude'));
  expect(candidatePaths('codex', env)).toEqual([codex]);
  expect(candidatePaths('claude', env)).toEqual([claude]);
});

it('follows an npm shim on PATH to the native OpenCode binary', () => {
  touch('npm', 'opencode.cmd');
  const native = touch(
    'npm',
    'node_modules',
    '@opencode',
    'cli',
    'bin',
    exe('opencode'),
  );
  const env = {
    PATH: join(root, 'npm'),
    USERPROFILE: root,
    LOCALAPPDATA: root,
  };
  expect(candidatePaths('opencode', env)).toEqual([native]);
});

it('reports unavailable and failed runtimes distinctly', () => {
  const env = { PATH: '', USERPROFILE: root, LOCALAPPDATA: root };
  expect(discoverRuntime('codex', { env }).status).toBe('unavailable');
  expect(
    discoverRuntime('codex', { executable: process.execPath }).status,
  ).toBe('failed');
});
