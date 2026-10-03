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
const { createQueue } = await load('src/queue.js');
const { createWorker } = await load('src/worker.js');
const index = await load('src/index.js');
const seen = [];
const queue = createQueue({ onEvent: (event) => seen.push(event) });
queue.push('a');
assert.equal(queue.shift(), 'a');
assert.equal(queue.shift(), undefined);
assert.deepEqual(seen, [
  { type: 'push', item: 'a' },
  { type: 'shift', item: 'a' },
]);
const plain = createQueue();
plain.push(1);
plain.push(2);
plain.push(3);
const events = [];
const boom = new Error('boom');
const worker = createWorker(
  async (item) => {
    if (item === 2) throw boom;
  },
  { onEvent: (event) => events.push(event) },
);
assert.equal(await worker.run(plain), 2);
assert.deepEqual(events, [
  { type: 'done', item: 1 },
  { type: 'error', item: 2, error: boom },
  { type: 'done', item: 3 },
]);
const quiet = createQueue();
quiet.push('x');
assert.equal(await createWorker(async () => {}).run(quiet), 1);
assert.equal(typeof index.createQueue, 'function');
assert.equal(typeof index.createWorker, 'function');
const all = [];
const system = index.createSystem(async () => {}, {
  onEvent: (event) => all.push(event.type),
});
system.queue.push('job');
assert.equal(await system.worker.run(system.queue), 1);
assert.deepEqual(all, ['push', 'shift', 'done']);
const bare = index.createSystem(async () => {});
bare.queue.push(1);
assert.equal(await bare.worker.run(bare.queue), 1);
