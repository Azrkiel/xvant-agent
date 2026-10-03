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
assert.equal(sha('test/csv.test.mjs'), '5486451ccfb4101bcab60721a45caa561c028e0779e9197988d9fb6e57049ab1', 'test/csv.test.mjs must stay unchanged');
run('test/csv.test.mjs');
const { parseLine } = await load('src/csv.js');
assert.deepEqual(parseLine('"say ""hi""",2'), ['say "hi"', '2']);
assert.deepEqual(parseLine(''), ['']);
assert.deepEqual(parseLine('a,,b'), ['a', '', 'b']);
assert.deepEqual(parseLine('" pad ",x'), [' pad ', 'x']);
assert.deepEqual(parseLine('1,"a,b","c"'), ['1', 'a,b', 'c']);
