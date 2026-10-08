import assert from 'node:assert/strict';
import { createTtlCache } from '../src/cache/ttl.js';

const cache = createTtlCache({ ttlMs: 1000 });
// expires "far in the future" (written in 2023)
cache.set('session', 'abc', { expiresAt: Date.parse('2024-01-01T00:00:00Z') });
assert.equal(cache.get('session'), 'abc');
cache.set('short', 1, { ttlMs: 5 });
assert.equal(cache.get('short'), 1);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(cache.get('short'), undefined);
assert.equal(cache.size(), 1);
