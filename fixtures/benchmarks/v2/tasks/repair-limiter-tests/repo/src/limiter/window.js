import { systemClock } from '../util/clock.js';

// Fixed windows per key. A window opens at a key's first hit and lasts
// `windowMs`; at most `limit` hits are allowed in it.
export function createWindowLimiter({ limit, windowMs, clock = systemClock }) {
  const windows = new Map();
  return {
    // { allowed, remaining, retryAfterMs }: retryAfterMs is the time until the
    // window ends when the hit is refused and 0 when it is allowed.
    hit(key) {
      const now = clock.now();
      let window = windows.get(key);
      if (!window || now >= window.start + windowMs) {
        window = { start: now, count: 0 };
        windows.set(key, window);
      }
      window.count += 1;
      const allowed = window.count <= limit;
      return {
        allowed,
        remaining: Math.max(0, limit - window.count),
        retryAfterMs: allowed ? 0 : window.start + windowMs - now,
      };
    },
  };
}
