import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
const read = (path) => readFileSync(path, 'utf8');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (file) => execFileSync(process.execPath, [file], { stdio: 'pipe' });
const handoff = JSON.parse(read('HANDOFF.json'));
assert.ok(typeof handoff.summary === 'string' && handoff.summary.length > 10, 'summary');
for (const key of ['completed', 'remaining', 'openQuestions', 'failedAttempts'])
  assert.ok(Array.isArray(handoff[key]), key + ' is a list');
assert.ok(handoff.remaining.some((item) => String(item).includes('src/export.js')), 'remaining names src/export.js');
assert.ok(handoff.failedAttempts.some((item) => /chunk/i.test(JSON.stringify(item))), 'records the failed chunking attempt');
