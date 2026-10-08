import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store/store.js';

const store = createStore(join(mkdtempSync(join(tmpdir(), 'notes-')), 'n.json'));
store.add({ text: 'milk', tags: ['home', 'errands'] });
store.add({ text: 'tax', tags: ['errands'] });
store.add({ text: 'plain' });
assert.deepEqual(store.list().map((n) => n.tags), [['home', 'errands'], ['errands'], []]);
assert.deepEqual(store.list({ tag: 'errands' }).map((n) => n.text), ['milk', 'tax']);
assert.deepEqual(store.list({ tag: 'none' }), []);
assert.deepEqual(store.tags(), [
  { tag: 'errands', count: 2 },
  { tag: 'home', count: 1 },
]);
