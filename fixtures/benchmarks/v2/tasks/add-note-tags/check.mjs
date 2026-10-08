import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path) => import(pathToFileURL(resolve(path)).href);

// parser
const { parseNote } = await load('src/parse/line.js');
assert.deepEqual(parseNote('Buy milk'), { text: 'Buy milk', tags: [], done: false });
assert.deepEqual(parseNote('  Buy   milk #Home  #errands #HOME '), {
  text: 'Buy milk',
  tags: ['home', 'errands'],
  done: false,
});
assert.equal(parseNote('#a pay #b rent').text, 'pay rent');
assert.deepEqual(parseNote('#a pay #b rent').tags, ['a', 'b']);
assert.equal(parseNote('learn c# and a#b #').text, 'learn c# and a#b #');
assert.deepEqual(parseNote('learn c# and a#b #').tags, []);
assert.deepEqual(parseNote('x #snake_case #dash-ed #n1').tags, ['snake_case', 'dash-ed', 'n1']);
assert.throws(() => parseNote('#home #errands'), TypeError);
assert.throws(() => parseNote('   '), TypeError);

// store
const dir = mkdtempSync(join(tmpdir(), 'xvant-tags-'));
try {
  const { createStore } = await load('src/store/store.js');
  const store = createStore(join(dir, 'store.json'));
  const first = store.add({ text: 'milk', tags: ['home', 'errands'] });
  assert.deepEqual(first.tags, ['home', 'errands']);
  store.add({ text: 'tax', tags: ['errands'] });
  store.add({ text: 'plain' });
  store.add({ text: 'gym', tags: ['health'] });
  store.add({ text: 'sauna', tags: ['health'] });
  assert.deepEqual(store.list().map((n) => n.tags), [['home', 'errands'], ['errands'], [], ['health'], ['health']]);
  assert.deepEqual(store.list({ tag: 'errands' }).map((n) => n.text), ['milk', 'tax']);
  assert.deepEqual(store.list({ tag: 'ERRANDS' }).map((n) => n.text), ['milk', 'tax']);
  assert.deepEqual(store.list({}).length, 5);
  assert.deepEqual(store.list({ tag: 'nothing' }), []);
  assert.deepEqual(store.tags(), [
    { tag: 'errands', count: 2 },
    { tag: 'health', count: 2 },
    { tag: 'home', count: 1 },
  ]);
  assert.deepEqual(createStore(join(dir, 'empty.json')).tags(), []);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// command line
const cwd = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'xvant-tags-cli-'));
const notesFile = join(home, 'notes.json');
const cli = (...args) => {
  const r = spawnSync(process.execPath, [join(cwd, 'bin/notes.js'), ...args], {
    cwd: home,
    env: { ...process.env, NOTES_FILE: notesFile },
    encoding: 'utf8',
  });
  return { code: r.status, lines: r.stdout.split('\n').filter(Boolean) };
};
try {
  assert.deepEqual(cli('add', 'Buy', 'milk', '#home', '#errands'), { code: 0, lines: ['added 1'] });
  assert.deepEqual(cli('add', 'Pay tax #Errands'), { code: 0, lines: ['added 2'] });
  assert.deepEqual(cli('add', 'Call mum'), { code: 0, lines: ['added 3'] });
  assert.equal(cli('add', '#only').code, 1);
  assert.deepEqual(cli('list').lines, [
    '1 [ ] Buy milk  #home #errands',
    '2 [ ] Pay tax  #errands',
    '3 [ ] Call mum',
  ]);
  assert.deepEqual(cli('list', '--tag', 'errands').lines, [
    '1 [ ] Buy milk  #home #errands',
    '2 [ ] Pay tax  #errands',
  ]);
  assert.deepEqual(cli('list', '--tag', 'HOME').lines, ['1 [ ] Buy milk  #home #errands']);
  assert.deepEqual(cli('list', '--tag', 'none'), { code: 0, lines: [] });
  assert.deepEqual(cli('tags'), { code: 0, lines: ['errands 2', 'home 1'] });
  assert.equal(cli('done', '2').code, 0);
  assert.deepEqual(cli('list', '--tag', 'errands').lines[1], '2 [x] Pay tax  #errands');
  assert.equal(cli('rm', '1').code, 0);
  assert.deepEqual(cli('tags').lines, ['errands 1']);
  assert.deepEqual(cli('list').lines, ['2 [x] Pay tax  #errands', '3 [ ] Call mum']);
} finally {
  rmSync(home, { recursive: true, force: true });
}

// documentation
const readme = readFileSync('README.md', 'utf8');
assert.match(readme, /--tag/);
assert.match(readme, /\btags\b/);
