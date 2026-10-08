import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Runs the per-module test files. Each must exist and exit with code 0.
const root = fileURLToPath(new URL('..', import.meta.url));
for (const name of ['slug', 'wrap', 'semver', 'csv']) {
  const file = 'test/' + name + '.test.mjs';
  assert.ok(existsSync(root + file), file + ' is missing');
  const run = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, file + ' fails:\n' + run.stderr);
}
