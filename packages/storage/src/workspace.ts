import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { ArtifactStore, safePath } from './artifacts.ts';

export interface WorkspaceSnapshot {
  treeHash: string;
  artifactSetHash: string;
  workspaceRootHash: string;
  artifactHashes: string[];
}
function fail(code: string): never {
  throw new Error(code);
}
/** Bounded trusted-local snapshot. Excludes only root .git metadata; rejects links. */
export function captureWorkspace(
  root: string,
  objects: ArtifactStore,
  options: { maxBytes?: number; maxEntries?: number; maxDepth?: number } = {},
): WorkspaceSnapshot {
  if (!isAbsolute(root)) fail('INVALID_INPUT');
  const absolute = safePath(root);
  if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isDirectory())
    fail('UNSAFE_PATH');
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 1024;
  const maxDepth = options.maxDepth ?? 32;
  for (const [value, maximum] of [
    [maxBytes, 16 * 1024 * 1024],
    [maxEntries, 1024],
    [maxDepth, 32],
  ])
    if (!Number.isSafeInteger(value) || value! < 1 || value! > maximum!)
      fail('INVALID_INPUT');
  const files: {
    path: string;
    hash: string;
    bytes: number;
    executable: boolean;
  }[] = [];
  const directories: string[] = [];
  let entries = 0,
    used = 0;
  const same = (a: Stats, b: Stats) =>
    a.ino === b.ino &&
    a.dev === b.dev &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode;
  const walk = (directory: string, relative: string, depth: number): void => {
    if (depth > maxDepth) fail('LIMIT_EXCEEDED');
    safePath(directory);
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail('UNSAFE_PATH');
    const names: string[] = [];
    const dir = opendirSync(directory);
    try {
      for (let item = dir.readSync(); item; item = dir.readSync()) {
        if (!relative && item.name === '.git') continue;
        if (++entries > maxEntries) fail('LIMIT_EXCEEDED');
        names.push(item.name);
      }
    } finally {
      dir.closeSync();
    }
    for (const name of names.sort()) {
      const path = safePath(join(directory, name));
      const rel = relative ? relative + '/' + name : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail('UNSAFE_PATH');
      if (stat.isDirectory()) {
        directories.push(rel);
        walk(path, rel, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) fail('UNSAFE_PATH');
      if (stat.size > maxBytes - used) fail('LIMIT_EXCEEDED');
      const fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let bytes: Buffer;
      try {
        if (!same(stat, fstatSync(fd))) fail('WORKSPACE_CHANGED');
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = readSync(
            fd,
            buffer,
            length,
            buffer.length - length,
            null,
          );
          if (!read) break;
          length += read;
        }
        if (length !== stat.size || !same(stat, fstatSync(fd)))
          fail('WORKSPACE_CHANGED');
        bytes = buffer.subarray(0, length);
      } finally {
        closeSync(fd);
      }
      safePath(path);
      if (!same(stat, lstatSync(path))) fail('WORKSPACE_CHANGED');
      used += bytes.length;
      files.push({
        path: rel,
        hash: objects.put(bytes),
        bytes: bytes.length,
        executable: (stat.mode & 0o111) !== 0,
      });
    }
    safePath(directory);
    if (!same(before, lstatSync(directory))) fail('WORKSPACE_CHANGED');
  };
  walk(absolute, '', 0);
  const treeHash = objects.put(
    Buffer.from(
      JSON.stringify({
        version: 1,
        directories: directories.sort(),
        files: files.sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
      }),
    ),
  );
  const hashes = [
    ...new Set([treeHash, ...files.map((file) => file.hash)]),
  ].sort();
  const artifactSetHash = objects.put(
    Buffer.from(JSON.stringify({ version: 1, hashes })),
  );
  return {
    treeHash,
    artifactSetHash,
    artifactHashes: [...new Set([...hashes, artifactSetHash])].sort(),
    workspaceRootHash: createHash('sha256').update(absolute).digest('hex'),
  };
}
