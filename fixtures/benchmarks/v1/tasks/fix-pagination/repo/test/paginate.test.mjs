import assert from 'node:assert/strict';
import { paginate, pageCount } from '../src/paginate.js';
const items = [1, 2, 3, 4, 5, 6, 7];
assert.deepEqual(paginate(items, 1, 3), [1, 2, 3]);
assert.deepEqual(paginate(items, 3, 3), [7]);
assert.equal(pageCount(items, 3), 3);
