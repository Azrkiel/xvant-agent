import assert from 'node:assert/strict';
import { clamp, sum } from '../src/math.js';
assert.equal(sum([1, 2, 3]), 6);
assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-1, 0, 10), 0);
assert.equal(clamp(11, 0, 10), 10);
assert.throws(() => clamp(1, 5, 2), RangeError);
