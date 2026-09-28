import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from './artifacts.ts';
import { captureWorkspace } from './workspace.ts';
let root: string;
let workspace: string;
let objects: ArtifactStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-attest-'));
  workspace = join(root, 'work');
  mkdirSync(workspace);
  objects = new ArtifactStore(join(root, 'objects'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('captures deterministic content and a retrievable manifest from actual files', () => {
  mkdirSync(join(workspace, 'src'));
  writeFileSync(join(workspace, 'src', 'a.txt'), 'real bytes');
  writeFileSync(join(workspace, 'z.txt'), 'z');
  const a = captureWorkspace(workspace, objects);
  expect(captureWorkspace(workspace, objects)).toEqual(a);
  const manifest = JSON.parse(objects.get(a.treeHash).toString());
  expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
    'src/a.txt',
    'z.txt',
  ]);
  expect(objects.get(manifest.files[0].hash).toString()).toBe('real bytes');
  expect(a.artifactHashes).toContain(a.treeHash);
  writeFileSync(join(workspace, 'z.txt'), 'changed');
  expect(captureWorkspace(workspace, objects).treeHash).not.toBe(a.treeHash);
});
it('includes empty directories but excludes root Git metadata', () => {
  const empty = captureWorkspace(workspace, objects);
  mkdirSync(join(workspace, '.git'));
  writeFileSync(join(workspace, '.git', 'config'), 'private');
  expect(captureWorkspace(workspace, objects)).toEqual(empty);
  mkdirSync(join(workspace, 'empty'));
  expect(captureWorkspace(workspace, objects).treeHash).not.toBe(
    empty.treeHash,
  );
});
it('rejects junctions instead of reading outside the workspace', () => {
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(workspace, 'linked'), 'junction');
  expect(() => captureWorkspace(workspace, objects)).toThrow('UNSAFE_PATH');
});
it('rejects a linked workspace root', () => {
  const linked = join(root, 'linked');
  symlinkSync(workspace, linked, 'junction');
  expect(() => captureWorkspace(linked, objects)).toThrow('UNSAFE_PATH');
});
it('enforces file, byte and depth budgets', () => {
  writeFileSync(join(workspace, 'a'), '12345');
  expect(() => captureWorkspace(workspace, objects, { maxBytes: 4 })).toThrow(
    'LIMIT_EXCEEDED',
  );
  writeFileSync(join(workspace, 'b'), 'x');
  expect(() => captureWorkspace(workspace, objects, { maxEntries: 1 })).toThrow(
    'LIMIT_EXCEEDED',
  );
  mkdirSync(join(workspace, 'dir'));
  mkdirSync(join(workspace, 'dir', 'nested'));
  expect(() => captureWorkspace(workspace, objects, { maxDepth: 1 })).toThrow(
    'LIMIT_EXCEEDED',
  );
});
