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
const { formatMoney, formatCount } = await load('src/format.js');
const { total, summary } = await load('src/cart.js');
const { report } = await load('src/report.js');
assert.equal(formatMoney(123456, 'USD'), 'USD 1,234.56');
assert.equal(formatMoney(5, 'EUR'), 'EUR 0.05');
assert.equal(formatMoney(100000000, 'USD'), 'USD 1,000,000.00');
assert.equal(formatMoney(0, 'USD'), 'USD 0.00');
for (const bad of [-1, 1.5, NaN])
  assert.throws(() => formatMoney(bad, 'USD'), RangeError);
assert.equal(formatCount(3), '3');
const cart = {
  id: 'c1',
  items: [
    { priceCents: 250, quantity: 2 },
    { priceCents: 100000, quantity: 1 },
  ],
};
assert.equal(total(cart), 100500);
assert.deepEqual(summary(cart, 'USD'), { items: 3, total: 'USD 1,005.00' });
const empty = { id: 'c2', items: [] };
assert.equal(report([cart, empty], 'USD'), 'c1: USD 1,005.00\nc2: USD 0.00');
assert.equal(report([cart, empty]), 'c1: 100500\nc2: 0');
