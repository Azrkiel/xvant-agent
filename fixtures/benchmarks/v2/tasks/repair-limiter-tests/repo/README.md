# limits

Caches and rate limiters with an injectable clock (`{ now() }`, milliseconds).

- `src/cache/lru.js` `createLru(capacity)`: a least-recently-used cache
- `src/cache/ttl.js` `createTtlCache({ clock, ttlMs })`: entries that expire
- `src/limiter/token-bucket.js` `createTokenBucket({ capacity, refillPerSec, clock })`
- `src/limiter/window.js` `createWindowLimiter({ limit, windowMs, clock })`: fixed windows per key
- `src/util/` the system clock and a retry-time formatter

Tests are plain Node scripts in `test/`, run with `node test/<name>.test.mjs`. They exit with a
non-zero code when an assertion fails. The library code is believed to be correct; see
`TEST-REPORT.md` for what is wrong with the tests.
