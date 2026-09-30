import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
const read = (path) => readFileSync(path, 'utf8');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (file) => execFileSync(process.execPath, [file], { stdio: 'pipe' });
assert.ok(existsSync('docs/MAP.md'), 'docs/MAP.md is missing');
const lines = read('docs/MAP.md').split('\n');
for (const [path, name] of [
  ['src/index.js', 'main'],
  ['src/stock.js', 'reserveItem'],
  ['src/pricing.js', 'applyDiscount'],
  ['src/util/format.js', 'formatCurrency'],
])
  assert.ok(lines.some((line) => line.includes(path) && line.includes(name)), path + ' with ' + name);
assert.ok(lines.some((line) => /entry/i.test(line) && line.includes('src/index.js')), 'entry point');
