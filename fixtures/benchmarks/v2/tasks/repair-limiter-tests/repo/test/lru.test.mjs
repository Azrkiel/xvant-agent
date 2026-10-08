import assert from 'node:assert/strict';
import { createLru } from '../src/cache/lru.js';

const lru = createLru(2);
lru.set('a', 1);
lru.set('b', 2);
assert.equal(lru.get('a'), 1);
lru.set('c', 3);
// 'a' was just read, so it is the most recent and 'b' should be evicted
assert.equal(lru.has('a'), false);
assert.equal(lru.has('b'), true);
assert.deepEqual(lru.keys(), ['b', 'c']);
assert.equal(lru.size(), 2);
assert.throws(() => createLru(0), RangeError);
