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
assert.equal(sha('src/duration.js'), '40b656a020a7464dd8cb3508ce79d3a287fbdb5788b10a426578856f68a2dea1', 'src/duration.js must stay unchanged');
run('test/duration.test.mjs');
const source = readFileSync('src/duration.js', 'utf8');
for (const [find, replace] of [["* 3600","* 360"],["Number(m) * 60","Number(m) * 0"],["throw new SyntaxError('invalid duration: ' + text);","return 0;"],["+ Number(s);","+ Number(s) * 60;"]]) {
  const mutant = source.replace(find, replace);
  assert.notEqual(mutant, source);
  assert.equal(
    failsOn('test/duration.test.mjs', 'src/duration.js', mutant),
    true,
    'the test must fail when ' + find + ' becomes ' + replace,
  );
}
