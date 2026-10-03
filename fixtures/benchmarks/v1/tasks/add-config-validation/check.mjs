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
assert.equal(sha('test/config.test.mjs'), '30f4d584bc008ca103c21e37ab1ed8d6103f697eba02611736336a01d2c6cbbb', 'test/config.test.mjs must stay unchanged');
run('test/config.test.mjs');
const { loadConfig } = await load('src/config.js');
assert.deepEqual(loadConfig(), { host: 'localhost', port: 8080 });
assert.equal(loadConfig({ port: '3000' }).port, 3000);
for (const port of [0, 65536, 1.5, 'abc', -1, NaN])
  assert.throws(() => loadConfig({ port }), TypeError, String(port));
assert.equal(loadConfig({ port: 65535 }).port, 65535);
assert.equal(Object.isFrozen(loadConfig({})), true);
