import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path) => import(pathToFileURL(resolve(path)).href);
const { parseTimestamp } = await load('src/parse/timestamp.js');
const { percentile } = await load('src/aggregate/stats.js');
const { renderTable } = await load('src/report/table.js');
const { main } = await load('src/cli/cli.js');

// 1. zone offsets of both signs
const utc = Date.UTC(2025, 2, 4, 15, 15, 30);
assert.equal(parseTimestamp('2025-03-04T15:15:30Z'), utc);
assert.equal(parseTimestamp('2025-03-04T10:15:30-05:00'), utc);
assert.equal(parseTimestamp('2025-03-04T17:15:30+02:00'), utc);
assert.equal(parseTimestamp('2025-03-04T20:45:30+05:30'), utc);
assert.equal(parseTimestamp('2025-03-04T06:45:30-08:30'), utc);
assert.equal(parseTimestamp('2025-03-04T23:59:59-23:00'), Date.UTC(2025, 2, 5, 22, 59, 59));
assert.equal(parseTimestamp('2025-03-04 15:15:30Z'), null);
assert.equal(parseTimestamp('nope'), null);

// 2. nearest-rank percentiles
const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
assert.equal(percentile(twenty, 95), 190);
assert.equal(percentile(twenty, 50), 100);
assert.equal(percentile(twenty, 100), 200);
assert.equal(percentile(twenty, 5), 10);
assert.equal(percentile([120, 480, 200, 160], 50), 160);
assert.equal(percentile([120, 480, 200, 160], 95), 480);
assert.equal(percentile([120, 480, 200, 160], 25), 120);
assert.equal(percentile([300, 100, 50], 50), 100);
assert.equal(percentile([7], 50), 7);
assert.equal(percentile([7], 95), 7);
assert.equal(percentile([], 95), 0);
const unsorted = [5, 1, 4];
percentile(unsorted, 50);
assert.deepEqual(unsorted, [5, 1, 4]);

// 3. table columns are as wide as their widest cell
assert.equal(
  renderTable(['name', 'n'], [['alpha-service', 1], ['b', 22]]),
  ['name           n', '-------------  --', 'alpha-service  1', 'b              22'].join('\n'),
);
assert.equal(
  renderTable(['a', 'bb', 'c'], [[1, 2, 'last'], ['wide', 3, 4]]),
  ['a     bb  c', '----  --  ----', '1     2   last', 'wide  3   4'].join('\n'),
);
assert.equal(renderTable(['a'], []), 'a\n-');

// 4. the command line, on the sample and on a log with every zone and level case
const expected = [
  'hour               service  count  errors  p50  p95',
  '-----------------  -------  -----  ------  ---  ---',
  '2025-03-04T15:00Z  api      4      1       160  480',
  '2025-03-04T15:00Z  web      1      0       90   90',
  '2025-03-04T16:00Z  web      3      2       100  300',
].join('\n');
const lines = [];
assert.equal(main(['summary', 'samples/app.log'], { out: (text) => lines.push(text) }), 0);
assert.equal(lines.join('\n'), expected);

const log = readFileSync('samples/app.log', 'utf8');
const run = (...args) => {
  const out = [];
  const code = main(['summary', 'x.log', ...args], { out: (text) => out.push(text), readFile: () => log });
  return { code, text: out.join('\n') };
};
const errorsOnly = [
  'hour               service  count  errors  p50  p95',
  '-----------------  -------  -----  ------  ---  ---',
  '2025-03-04T15:00Z  api      1      1       480  480',
  '2025-03-04T16:00Z  web      2      2       100  300',
].join('\n');
for (const level of ['ERROR', 'error', 'Error'])
  assert.deepEqual(run('--level', level), { code: 0, text: errorsOnly }, 'level ' + level);
assert.equal(
  run('--service', 'web', '--level', 'info').text,
  [
    'hour               service  count  errors  p50  p95',
    '-----------------  -------  -----  ------  ---  ---',
    '2025-03-04T16:00Z  web      1      0       50   50',
  ].join('\n'),
);
assert.equal(run('--level', 'warn').text.split('\n').length, 3);
assert.equal(run('--level', 'debug').text, 'hour  service  count  errors  p50  p95\n----  -------  -----  ------  ---  ---');
assert.equal(run('--bogus', 'x').code, 1);

const wide = [
  '2025-03-04T23:30:00-05:00 INFO a-very-long-service-name 1000ms GET /',
  '2025-03-05T04:59:59Z ERROR a-very-long-service-name 20ms GET /',
  '2025-03-05T05:00:00Z INFO b 5ms GET /',
].join('\n');
const out = [];
main(['summary', 'w.log'], { out: (text) => out.push(text), readFile: () => wide });
const grid = [
  ['hour', 'service', 'count', 'errors', 'p50', 'p95'],
  ['2025-03-05T04:00Z', 'a-very-long-service-name', '2', '1', '20', '1000'],
  ['2025-03-05T05:00Z', 'b', '1', '0', '5', '5'],
];
const widths = grid[0].map((_, i) => Math.max(...grid.map((row) => row[i].length)));
const render = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
assert.equal(
  out.join('\n'),
  [render(grid[0]), widths.map((w) => '-'.repeat(w)).join('  '), render(grid[1]), render(grid[2])].join('\n'),
);
// the same through the executable, in another time zone
const proc = spawnSync(process.execPath, [join(process.cwd(), 'bin/logstat.js'), 'summary', 'samples/app.log', '--level', 'error'], {
  encoding: 'utf8',
  env: { ...process.env, TZ: 'Asia/Kolkata' },
});
assert.equal(proc.status, 0);
assert.equal(proc.stdout.trimEnd(), errorsOnly);
const missing = spawnSync(process.execPath, [join(process.cwd(), 'bin/logstat.js'), 'summary', 'no-such.log'], { encoding: 'utf8' });
assert.equal(missing.status, 1);
assert.match(missing.stdout, /^error: /);
