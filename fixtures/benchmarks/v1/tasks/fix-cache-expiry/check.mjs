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
assert.equal(sha('test/cache.test.mjs'), 'c00178b802279358f6b410f7b594a2b267a5b48761da5720df55f7820409d371', 'test/cache.test.mjs must stay unchanged');
run('test/cache.test.mjs');
const { createCache } = await load('src/cache.js');
let t = 0;
const cache = createCache(100, () => t);
cache.set('a', 1);
t = 60;
cache.set('b', 2);
t = 99;
assert.equal(cache.size(), 2);
t = 100;
assert.equal(cache.size(), 1);
assert.equal(cache.has('b'), true);
assert.equal(cache.has('a'), false);
t = 160;
assert.equal(cache.size(), 0);
cache.set('c', 3);
t = 250;
cache.set('c', 4);
t = 300;
assert.equal(cache.get('c'), 4);
