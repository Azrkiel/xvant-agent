import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
const read = (path) => readFileSync(path, 'utf8');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (file) => execFileSync(process.execPath, [file], { stdio: 'pipe' });
assert.ok(existsSync('PLAN.md'), 'PLAN.md is missing');
const text = read('PLAN.md');
const steps = text.split('\n').filter((line) => /^\d+\.\s/.test(line));
assert.ok(steps.length >= 3, 'at least three numbered steps');
for (const file of ['src/limiter.js', 'src/server.js'])
  assert.ok(steps.some((step) => step.includes(file)), 'a step names ' + file);
assert.ok(steps.some((step) => /test/i.test(step)), 'a step names a test');
assert.ok(/risk/i.test(text), 'risks are listed');
