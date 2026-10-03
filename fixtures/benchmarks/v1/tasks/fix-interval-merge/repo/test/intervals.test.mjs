import assert from 'node:assert/strict';
import { overlaps, merge } from '../src/intervals.js';
assert.equal(overlaps({ start: 0, end: 5 }, { start: 5, end: 10 }), false);
assert.equal(overlaps({ start: 0, end: 5 }, { start: 4, end: 10 }), true);
assert.deepEqual(
  merge([
    { start: 0, end: 10 },
    { start: 2, end: 3 },
  ]),
  [{ start: 0, end: 10 }],
);
