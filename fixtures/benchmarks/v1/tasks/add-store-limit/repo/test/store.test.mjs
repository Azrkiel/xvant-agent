import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
const store = createStore({ maxEntries: 2 });
store.set('a', 1);
store.set('b', 2);
store.set('c', 3);
assert.equal(store.get('a'), undefined);
assert.deepEqual(store.keys(), ['b', 'c']);
