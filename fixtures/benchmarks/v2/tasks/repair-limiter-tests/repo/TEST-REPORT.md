# Test report

Findings from the last review of `test/`. The code under `src/` was checked by hand and is
correct; every problem is in a test.

| File | Finding |
| --- | --- |
| `test/lru.test.mjs` | Fails. It expects the wrong entry to be evicted after a `get`. |
| `test/ttl.test.mjs` | Fails today, and passed before 2024. It checks an entry against a fixed calendar date and waits on the real clock. A test must not depend on the date it runs on. |
| `test/window.test.mjs` | Fails. The checks share one limiter and one clock, so a later check sees the hits of an earlier one. Each check must set up its own state. |
| `test/bucket.test.mjs` | Passes, but proves nothing: none of its assertions can fail when the bucket is broken. |

A repaired test keeps checking the same module and must still fail when that module is
broken, for example if the least recently used entry is not the one evicted, an entry never
expires, a window never resets, or the bucket stops refilling or stops being capped.
