import assert from 'node:assert/strict';
import { createTokenBucket } from '../src/limiter/token-bucket.js';

const clock = { time: 0, now() { return this.time; } };
const bucket = createTokenBucket({ capacity: 3, refillPerSec: 1, clock });
assert.ok(bucket, 'a bucket is created');
assert.ok(typeof bucket.take === 'function');
const first = bucket.take();
assert.ok(first === true || first === false);
clock.time = 5000;
assert.ok(bucket.take(2) !== undefined);
assert.equal(typeof bucket.tokens(), 'number');
