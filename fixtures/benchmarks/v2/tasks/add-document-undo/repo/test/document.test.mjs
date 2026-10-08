import assert from 'node:assert/strict';
import { createDocument } from '../src/core/document.js';

const doc = createDocument(['a']);
assert.equal(doc.canUndo(), false);
assert.equal(doc.undo(), false);
doc.insert(2, 'b');
doc.replace(1, 'A');
doc.delete(2);
assert.deepEqual(doc.lines(), ['A']);
assert.equal(doc.undo(), true);
assert.deepEqual(doc.lines(), ['A', 'b']);
assert.equal(doc.undo(), true);
assert.deepEqual(doc.lines(), ['a', 'b']);
assert.equal(doc.canRedo(), true);
assert.equal(doc.redo(), true);
assert.deepEqual(doc.lines(), ['A', 'b']);
doc.insert(1, 'new');
assert.equal(doc.canRedo(), false);
assert.equal(doc.redo(), false);
assert.throws(() => doc.delete(9), RangeError);
assert.deepEqual(doc.lines(), ['new', 'A', 'b']);

const limited = createDocument([], { historyLimit: 2 });
for (const text of ['x', 'y', 'z']) limited.insert(1, text);
assert.equal(limited.undo(), true);
assert.equal(limited.undo(), true);
assert.equal(limited.undo(), false);
assert.deepEqual(limited.lines(), ['x']);
