import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = (data) => createHash('sha256').update(data).digest('hex');
function treeHash(root) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, prefix + name + '/');
      else files.push(prefix + name + '\0' + sha(readFileSync(path)));
    }
  };
  walk(root, '');
  return sha(files.join('\n'));
}
assert.equal(
  treeHash('src'),
  'e7dc4ecf1a9761a2d84f3b986e44f805a90a79c5e12ad4557dbd51b7015a12be',
  'the source under src/ must stay unchanged',
);

const scratch = mkdtempSync(join(tmpdir(), 'xvant-limits-'));
try {
  // A preload that moves the system date, to show a test does not depend on today's date.
  const shift = join(scratch, 'shift-date.mjs');
  writeFileSync(
    shift,
    `const Real = Date;
const offset = Number(process.env.XVANT_DATE_OFFSET_MS);
globalThis.Date = class extends Real {
  constructor(...args) {
    if (args.length === 0) super(Real.now() + offset);
    else super(...args);
  }
  static now() {
    return Real.now() + offset;
  }
};
`,
  );
  const years = (n) => String(Math.round(n * 365.25 * 86_400_000));
  const files = {
    lru: 'test/lru.test.mjs',
    ttl: 'test/ttl.test.mjs',
    window: 'test/window.test.mjs',
    bucket: 'test/bucket.test.mjs',
  };

  // The repaired tests pass on the real source, and on any date.
  const runAsync = (args, cwd, env = process.env) =>
    new Promise((done) => {
      const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on('close', (status) => {
        clearTimeout(timer);
        done({ status, stderr });
      });
    });
  const pool = async (list, work, size = 6) => {
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const item = list[next];
        next += 1;
        await work(item);
      }
    };
    await Promise.all(Array.from({ length: size }, worker));
  };
  for (const file of Object.values(files)) assert.ok(existsSync(file), file + ' exists');
  const dateRuns = Object.values(files).flatMap((file) =>
    [years(64), years(-26)].map((offset) => ({ file, offset })),
  );
  await pool(dateRuns, async ({ file, offset }) => {
    const run = await runAsync(['--import', pathToFileURL(shift).href, file], process.cwd(), {
      ...process.env,
      XVANT_DATE_OFFSET_MS: offset,
    });
    assert.equal(run.status, 0, file + ' passes with the date moved by ' + offset + ' ms: ' + run.stderr);
  });

  // Each test file must fail when its module is broken in one of these ways.
  const mutants = {
    lru: [
      ['src/cache/lru.js', 'map.delete(key);\n      map.set(key, value);\n      return value;', 'return value;', 'reading a key no longer makes it recent'],
      ['src/cache/lru.js', 'set(key, value) {\n      map.delete(key);\n', 'set(key, value) {\n', 'rewriting a key no longer makes it recent'],
      ['src/cache/lru.js', 'map.delete(map.keys().next().value)', 'map.delete([...map.keys()].pop())', 'the newest entry is evicted'],
      ['src/cache/lru.js', 'map.size > capacity', 'map.size >= capacity', 'the cache holds one entry too few'],
      ['src/cache/lru.js', 'capacity < 1', 'capacity < 0', 'capacity 0 is accepted'],
      ['src/cache/lru.js', '!Number.isInteger(capacity) || ', '', 'a fractional capacity is accepted'],
    ],
    ttl: [
      ['src/cache/ttl.js', 'clock.now() < entry.expiresAt', 'clock.now() <= entry.expiresAt', 'an entry lives one instant too long'],
      ['src/cache/ttl.js', 'options.expiresAt ?? clock.now() + ttl', 'clock.now() + ttl', 'expiresAt is ignored'],
      ['src/cache/ttl.js', 'options.ttlMs ?? ttlMs', 'ttlMs', 'a per-entry ttl is ignored'],
      ['src/cache/ttl.js', 'options.expiresAt ?? clock.now() + ttl', 'options.expiresAt ?? clock.now()', 'entries expire at once'],
      ['src/cache/ttl.js', '[...entries.values()].filter(live).length', 'entries.size', 'size counts expired entries'],
    ],
    window: [
      ['src/limiter/window.js', 'now >= window.start + windowMs', 'now > window.start + windowMs', 'the window lasts one instant too long'],
      ['src/limiter/window.js', 'window.count <= limit', 'window.count < limit', 'one hit too few is allowed'],
      ['src/limiter/window.js', 'Math.max(0, limit - window.count)', 'limit - window.count', 'remaining goes negative'],
      ['src/limiter/window.js', 'window.start + windowMs - now', 'windowMs', 'retryAfterMs ignores how much of the window is gone'],
      ['src/limiter/window.js', 'windows.set(key, window);', '', 'windows are not remembered'],
      ['src/limiter/window.js', 'windows.get(key)', "windows.get('shared')", 'keys share one window'],
    ],
    bucket: [
      ['src/limiter/token-bucket.js', 'Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec)', 'tokens + ((now - last) / 1000) * refillPerSec', 'the bucket is not capped'],
      ['src/limiter/token-bucket.js', 'tokens < n', 'tokens <= n', 'the last token cannot be taken'],
      ['src/limiter/token-bucket.js', '/ 1000', '/ 100', 'refill is ten times too fast'],
      ['src/limiter/token-bucket.js', ') * refillPerSec', ')', 'refillPerSec is ignored'],
      ['src/limiter/token-bucket.js', 'tokens -= n', 'tokens -= 1', 'a take removes one token whatever n is'],
      ['src/limiter/token-bucket.js', 'let tokens = capacity;', 'let tokens = 0;', 'the bucket starts empty'],
      ['src/limiter/token-bucket.js', 'last = now;', '', 'elapsed time is counted twice'],
    ],
  };
  const jobs = Object.entries(mutants).flatMap(([module, list]) =>
    list.map(([source, find, replace, what]) => ({ module, source, find, replace, what })),
  );
  await pool(jobs.map((job, index) => ({ ...job, index })), async ({ module, source, find, replace, what, index }) => {
    const dir = join(scratch, 'mutant-' + index);
    cpSync('src', join(dir, 'src'), { recursive: true });
    cpSync('test', join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const original = readFileSync(join(dir, source), 'utf8');
    assert.ok(original.includes(find), 'mutant is applicable: ' + find);
    writeFileSync(join(dir, source), original.replace(find, () => replace));
    const run = await runAsync([files[module]], dir);
    assert.notEqual(run.status, 0, files[module] + ' must fail when ' + what);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
