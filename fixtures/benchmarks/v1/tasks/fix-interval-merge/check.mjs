import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path) => import(pathToFileURL(resolve(path)).href);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (file, cwd = process.cwd()) => execFileSync(process.execPath, [file], { cwd, stdio: 'pipe' });
// Runs the workspace test against a changed copy of a source file; true when the test fails.
function failsOn(test, source, text) {
  const dir = mkdtempSync(join(tmpdir(), 'xvant-mutant-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, source), text);
    cpSync(test, join(dir, test));
    try {
      run(test, dir);
      return false;
    } catch {
      return true;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
void [assert, load, sha, run, failsOn];
assert.equal(sha('test/intervals.test.mjs'), '1a64fdd45cbb7131cd1dc1a1284e2bc2a55d531eb1e799f147a707a733f02d3b', 'test/intervals.test.mjs must stay unchanged');
run('test/intervals.test.mjs');
const { overlaps, merge } = await load('src/intervals.js');
assert.equal(overlaps({ start: 0, end: 5 }, { start: 1, end: 2 }), true);
assert.equal(overlaps({ start: 5, end: 10 }, { start: 0, end: 5 }), false);
const input = [
  { start: 5, end: 10 },
  { start: 0, end: 5 },
];
assert.deepEqual(merge(input), [{ start: 0, end: 10 }]);
assert.deepEqual(input, [
  { start: 5, end: 10 },
  { start: 0, end: 5 },
]);
assert.deepEqual(
  merge([
    { start: 2, end: 3 },
    { start: 0, end: 1 },
  ]),
  [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
  ],
);
