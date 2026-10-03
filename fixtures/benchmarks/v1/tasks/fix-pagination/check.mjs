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
assert.equal(sha('test/paginate.test.mjs'), '1e8b0a4102522c4ca9b1bc7add0c450ab8c32611e3456f1f579e80850b2a5281', 'test/paginate.test.mjs must stay unchanged');
run('test/paginate.test.mjs');
const { paginate, pageCount } = await load('src/paginate.js');
const items = [1, 2, 3, 4, 5, 6, 7];
assert.deepEqual(paginate(items, 2, 3), [4, 5, 6]);
assert.deepEqual(paginate(items, 4, 3), []);
assert.equal(pageCount([], 3), 0);
assert.equal(pageCount([1, 2, 3], 3), 1);
assert.equal(pageCount([1, 2, 3, 4], 3), 2);
