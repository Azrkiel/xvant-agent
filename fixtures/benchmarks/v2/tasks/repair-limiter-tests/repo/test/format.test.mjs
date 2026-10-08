import assert from 'node:assert/strict';
import { formatRetry } from '../src/util/format.js';

assert.equal(formatRetry(0), '0ms');
assert.equal(formatRetry(250), '250ms');
assert.equal(formatRetry(1000), '1s');
assert.equal(formatRetry(1001), '2s');
assert.equal(formatRetry(60_000), '1m');
assert.equal(formatRetry(65_000), '1m 5s');
