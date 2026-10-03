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
assert.equal(sha('test/retry.test.mjs'), 'cec97461be9ed3077eb14d7bdc3a1af3cad831771ebe9932508229b2b33716fc', 'test/retry.test.mjs must stay unchanged');
run('test/retry.test.mjs');
const { retry } = await load('src/retry.js');
const seen = [];
await assert.rejects(
  retry(async (n) => {
    seen.push(n);
    throw new Error('no');
  }, 3),
);
assert.deepEqual(seen, [1, 2, 3]);
let called = 0;
await assert.rejects(
  retry(async () => {
    called += 1;
  }, 0),
  RangeError,
);
assert.equal(called, 0);
let once = 0;
assert.equal(
  await retry(async () => {
    once += 1;
    return 7;
  }, 5),
  7,
);
assert.equal(once, 1);
