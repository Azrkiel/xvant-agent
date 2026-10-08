import assert from 'node:assert/strict';
import { run } from '../src/cli/repl.js';

const lines = [];
run(
  ['insert 1 one', 'insert 2 two', 'insert 3 three', 'undo 2', 'print', 'redo', 'print', 'undo 9', 'undo', 'redo 9', 'print'].join('\n'),
  { out: (line) => lines.push(line) },
);
assert.deepEqual(lines, [
  '1: one',
  '1: one',
  '2: two',
  'nothing to undo',
  '1: one',
  '2: two',
  '3: three',
]);
