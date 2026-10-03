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
assert.equal(sha('src/token.js'), 'ccaefae33b238a065ec89926d599463f57aac4333fc2db87633cf73141f7fea4', 'src/token.js must stay unchanged');
const text = readFileSync('test/token.test.mjs', 'utf8');
assert.equal(/Math\.random|Date\.now|setTimeout|performance/.test(text), false, 'no real clock or randomness');
for (let i = 0; i < 12; i += 1) run('test/token.test.mjs');
const source = readFileSync('src/token.js', 'utf8');
for (const [find, replace] of [["return now < token.expiresAt;","return now <= token.expiresAt;"],["return now < token.expiresAt;","return true;"],["expiresAt: now + ttlMs","expiresAt: now"]]) {
  const mutant = source.replace(find, replace);
  assert.notEqual(mutant, source);
  assert.equal(
    failsOn('test/token.test.mjs', 'src/token.js', mutant),
    true,
    'the test must fail when ' + find + ' becomes ' + replace,
  );
}
