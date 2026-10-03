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
assert.equal(sha('test/store.test.mjs'), '4fbf3468621a78a58e3631510b5279e44b34c82d97cc55d3daea0f96cbf66b55', 'test/store.test.mjs must stay unchanged');
run('test/store.test.mjs');
const { createStore } = await load('src/store.js');
const store = createStore({ maxEntries: 2 });
store.set('a', 1);
store.set('b', 2);
assert.equal(store.get('a'), 1);
store.set('c', 3);
assert.deepEqual(store.keys(), ['a', 'c']);
store.set('a', 9);
store.set('d', 4);
assert.deepEqual(store.keys(), ['a', 'd']);
assert.equal(store.get('a'), 9);
assert.equal(store.get('missing'), undefined);
const open = createStore();
for (let i = 0; i < 100; i += 1) open.set(i, i);
assert.equal(open.keys().length, 100);
