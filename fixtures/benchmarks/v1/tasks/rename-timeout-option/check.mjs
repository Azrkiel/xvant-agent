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
const { createClient } = await load('src/client.js');
const { createServer } = await load('src/server.js');
const { DEFAULTS, describe } = await load('src/config.js');
assert.deepEqual(createClient(), { timeoutMs: 1000 });
assert.deepEqual(createClient({ timeoutMs: 5 }), { timeoutMs: 5 });
assert.deepEqual(createClient({ timeout: 7 }), { timeoutMs: 7 });
assert.deepEqual(createClient({ timeout: 7, timeoutMs: 9 }), { timeoutMs: 9 });
assert.deepEqual(createServer(), { timeoutMs: 5000, port: 80 });
assert.deepEqual(createServer({ timeout: 3, port: 81 }), { timeoutMs: 3, port: 81 });
assert.deepEqual(createServer({ timeout: 3, timeoutMs: 4 }), { timeoutMs: 4, port: 80 });
assert.deepEqual(DEFAULTS, { timeoutMs: 1000 });
assert.equal(describe(), 'timeoutMs=1000');
assert.equal(describe({ timeout: 2 }), 'timeoutMs=2');
assert.equal(describe({ timeout: 2, timeoutMs: 6 }), 'timeoutMs=6');
