import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
const read = (path) => readFileSync(path, 'utf8');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (file) => execFileSync(process.execPath, [file], { stdio: 'pipe' });
run('test/math.test.mjs');
