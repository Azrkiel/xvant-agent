import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path) => import(pathToFileURL(resolve(path)).href);
const { createDocument } = await load('src/core/document.js');
const { run } = await load('src/cli/repl.js');

// document: undo and redo
const doc = createDocument(['a']);
assert.equal(doc.canUndo(), false);
assert.equal(doc.canRedo(), false);
assert.equal(doc.undo(), false);
assert.equal(doc.redo(), false);
doc.insert(2, 'b');
doc.replace(1, 'A');
doc.delete(2);
assert.deepEqual(doc.lines(), ['A']);
assert.equal(doc.canUndo(), true);
assert.equal(doc.undo(), true);
assert.deepEqual(doc.lines(), ['A', 'b']);
assert.equal(doc.text(), 'A\nb');
assert.equal(doc.undo(), true);
assert.deepEqual(doc.lines(), ['a', 'b']);
assert.equal(doc.undo(), true);
assert.deepEqual(doc.lines(), ['a']);
assert.equal(doc.canUndo(), false);
assert.equal(doc.undo(), false);
assert.deepEqual(doc.lines(), ['a'], 'the initial lines are not an edit');
assert.equal(doc.canRedo(), true);
assert.equal(doc.redo(), true);
assert.equal(doc.redo(), true);
assert.deepEqual(doc.lines(), ['A', 'b']);
assert.equal(doc.undo(), true);
assert.equal(doc.redo(), true);
assert.equal(doc.redo(), true);
assert.deepEqual(doc.lines(), ['A']);
assert.equal(doc.redo(), false);

// a new edit forgets what could be redone
doc.undo();
doc.undo();
assert.equal(doc.canRedo(), true);
doc.insert(1, 'new');
assert.equal(doc.canRedo(), false);
assert.equal(doc.redo(), false);
assert.deepEqual(doc.lines(), ['new', 'a', 'b']);
assert.equal(doc.undo(), true);
assert.deepEqual(doc.lines(), ['a', 'b']);

// a failed edit changes nothing, is not recorded and keeps redo available
const failing = createDocument(['x', 'y']);
failing.insert(3, 'z');
failing.undo();
assert.equal(failing.canRedo(), true);
assert.throws(() => failing.delete(9), RangeError);
assert.throws(() => failing.insert(0, 'q'), RangeError);
assert.throws(() => failing.replace(1.5, 'q'), RangeError);
assert.deepEqual(failing.lines(), ['x', 'y']);
assert.equal(failing.canRedo(), true);
assert.equal(failing.canUndo(), false);
assert.equal(failing.redo(), true);
assert.deepEqual(failing.lines(), ['x', 'y', 'z']);
assert.equal(failing.undo(), true);
assert.equal(failing.undo(), false);

// the history does not share state with the caller
const source = ['one'];
const copy = createDocument(source);
copy.insert(2, 'two');
source.push('changed');
copy.undo();
assert.deepEqual(copy.lines(), ['one']);
const snapshot = copy.lines();
snapshot.push('mutated');
copy.redo();
assert.deepEqual(copy.lines(), ['one', 'two']);

// historyLimit
const limited = createDocument([], { historyLimit: 2 });
for (const text of ['x', 'y', 'z']) limited.insert(1, text);
assert.deepEqual(limited.lines(), ['z', 'y', 'x']);
assert.equal(limited.undo(), true);
assert.equal(limited.undo(), true);
assert.equal(limited.undo(), false);
assert.deepEqual(limited.lines(), ['x']);
assert.equal(limited.redo(), true);
assert.equal(limited.redo(), true);
assert.deepEqual(limited.lines(), ['z', 'y', 'x']);
const off = createDocument([], { historyLimit: 0 });
off.insert(1, 'a');
assert.equal(off.canUndo(), false);
assert.equal(off.undo(), false);
assert.deepEqual(off.lines(), ['a']);
const long = createDocument();
for (let i = 1; i <= 100; i += 1) long.insert(i, String(i));
for (let i = 0; i < 100; i += 1) assert.equal(long.undo(), true);
assert.deepEqual(long.lines(), []);
const longer = createDocument();
for (let i = 1; i <= 101; i += 1) longer.insert(i, String(i));
let undone = 0;
while (longer.undo()) undone += 1;
assert.equal(undone, 100);
assert.deepEqual(longer.lines(), ['1']);

// script commands
const play = (script, document) => {
  const out = [];
  run(script, { out: (line) => out.push(line), ...(document ? { document } : {}) });
  return out;
};
assert.deepEqual(
  play('insert 1 one\ninsert 2 two\ninsert 3 three\nundo 2\nprint\nredo\nprint\nundo 9\nundo\nredo 9\nprint'),
  ['1: one', '1: one', '2: two', 'nothing to undo', '1: one', '2: two', '3: three'],
);
assert.deepEqual(play('undo'), ['nothing to undo']);
assert.deepEqual(play('redo'), ['nothing to redo']);
assert.deepEqual(play('insert 1 a\nundo\nredo\nredo\nprint'), ['nothing to redo', '1: a']);
assert.deepEqual(play('insert 1 a\ninsert 2 b\nundo 0\nprint'), ['1: a', '2: b']);
assert.deepEqual(play('insert 1 a\ninsert 5 b\nundo\nprint'), ['error: line 5 is out of range']);
assert.deepEqual(play('insert 1 a\nundo\nundo\nprint'), ['nothing to undo']);
assert.deepEqual(play('insert 1 a\nundo\ninsert 1 b\nredo\nprint'), ['nothing to redo', '1: b']);
assert.deepEqual(play('frobnicate 1'), ['error: unknown command: frobnicate']);
const shared = createDocument([], { historyLimit: 1 });
play('insert 1 a\ninsert 2 b\nundo 5\nprint', shared);
assert.deepEqual(shared.lines(), ['a']);

// the executable
const proc = spawnSync(process.execPath, [join(process.cwd(), 'bin/texted.js')], {
  input: 'insert 1 hello\ninsert 2 world\nreplace 1 HELLO\nundo\nprint\nundo 5\nundo\nredo 2\nprint\n',
  encoding: 'utf8',
});
assert.equal(proc.status, 0);
assert.deepEqual(proc.stdout.split('\n').filter(Boolean), [
  '1: hello',
  '2: world',
  'nothing to undo',
  '1: hello',
  '2: world',
]);

// documentation
const readme = readFileSync('README.md', 'utf8');
for (const word of ['undo', 'redo', 'historyLimit']) assert.ok(readme.includes(word), 'README mentions ' + word);
