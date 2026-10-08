import assert from 'node:assert/strict';
import { percentile } from '../src/aggregate/stats.js';

const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
assert.equal(percentile(twenty, 95), 19);
assert.equal(percentile(twenty, 50), 10);
assert.equal(percentile([40, 10, 30, 20], 50), 20);
assert.equal(percentile([7], 95), 7);
assert.equal(percentile(twenty, 100), 20);
assert.equal(percentile([], 50), 0);
