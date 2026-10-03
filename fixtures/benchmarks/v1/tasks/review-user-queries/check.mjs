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
assert.equal(sha('src/users.js'), '19f2b5ce5301b6e70001edff16d7e83ec8055703185d7042a1ed0a26dd7b3795', 'src/users.js must stay unchanged');
const review = JSON.parse(readFileSync('review/FINDINGS.json', 'utf8'));
assert.equal(review.approve, false);
assert.ok(Array.isArray(review.findings));
for (const finding of review.findings) {
  assert.equal(typeof finding.file, 'string');
  assert.equal(Number.isInteger(finding.line), true, 'line is a number');
  assert.ok(['high', 'medium', 'low'].includes(finding.severity));
  assert.equal(typeof finding.issue, 'string');
}
const inFile = review.findings.filter((f) => f.file === 'src/users.js');
assert.ok(
  inFile.some(
    (f) =>
      f.line >= 5 &&
      f.line <= 7 &&
      f.severity === 'high' &&
      /inject|concat|parameter|interpolat|escap/i.test(f.issue),
  ),
  'the SQL injection is reported as high',
);
assert.ok(
  inFile.some((f) => f.line >= 10 && f.line <= 12 && /await|promise/i.test(f.issue)),
  'the missing await is reported',
);
