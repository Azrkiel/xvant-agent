import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
const read = (path) => readFileSync(path, 'utf8');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (file) => execFileSync(process.execPath, [file], { stdio: 'pipe' });
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
assert.ok(existsSync('test/slugify.test.mjs'), 'test file is missing');
run('test/slugify.test.mjs');
const mutants = [
  "export function slugify(text) { return text.trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }\n",
  "export function slugify(text) { return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'); }\n",
  "export function slugify(text) { return text.trim().toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, ''); }\n",
  "export function slugify(text) { return text.toLowerCase().replace(/[^a-z0-9 ]+/g, '-').replace(/^-+|-+$/g, ''); }\n",
];
for (const [index, mutant] of mutants.entries()) {
  const copy = mkdtempSync(join(tmpdir(), 'slug-mutant-'));
  try {
    cpSync('.', copy, { recursive: true });
    writeFileSync(join(copy, 'src', 'slugify.js'), mutant);
    const result = spawnSync(process.execPath, ['test/slugify.test.mjs'], { cwd: copy, stdio: 'pipe' });
    assert.notEqual(result.status, 0, 'tests miss mutant ' + index);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
