import assert from 'node:assert/strict';
import { createWindowLimiter } from '../src/limiter/window.js';

const clock = { time: 0, now() { return this.time; } };
const limiter = createWindowLimiter({ limit: 2, windowMs: 1000, clock });

// hits up to the limit are allowed
assert.deepEqual(limiter.hit('u'), { allowed: true, remaining: 1, retryAfterMs: 0 });
assert.deepEqual(limiter.hit('u'), { allowed: true, remaining: 0, retryAfterMs: 0 });
assert.equal(limiter.hit('u').allowed, false);

// the window ends after windowMs
clock.time = 1000;
assert.deepEqual(limiter.hit('u'), { allowed: true, remaining: 1, retryAfterMs: 0 });

// a refused hit says how long to wait
clock.time = 1200;
limiter.hit('u');
limiter.hit('u');
assert.deepEqual(limiter.hit('u'), { allowed: false, remaining: 0, retryAfterMs: 1000 });
assert.deepEqual(limiter.hit('fresh'), { allowed: true, remaining: 1, retryAfterMs: 0 });
