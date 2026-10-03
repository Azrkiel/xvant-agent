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
assert.equal(sha('test/slug.test.mjs'), '7d45cb28ae975cccfbc62bf89a2306d43ae8ea1dfd8efedba31eba6ffea5d0bd', 'test/slug.test.mjs must stay unchanged');
run('test/slug.test.mjs');
const { slugify, uniqueSlug } = await load('src/slug.js');
assert.equal(slugify('  A  b!'), 'a-b');
const taken = new Set(['a', 'a-2']);
assert.equal(uniqueSlug('A', taken), 'a-3');
assert.equal(taken.has('a-3'), true);
const empty = new Set();
assert.equal(uniqueSlug('!!!', empty), 'untitled');
assert.equal(uniqueSlug('???', empty), 'untitled-2');
