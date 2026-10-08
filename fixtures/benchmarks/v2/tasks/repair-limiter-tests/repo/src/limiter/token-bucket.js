import { systemClock } from '../util/clock.js';

// A bucket that starts full, holds at most `capacity` tokens and gains
// `refillPerSec` tokens per second, continuously.
export function createTokenBucket({ capacity, refillPerSec, clock = systemClock }) {
  let tokens = capacity;
  let last = clock.now();
  const refill = () => {
    const now = clock.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
    last = now;
  };
  return {
    // Removes n tokens and returns true, or returns false and removes nothing.
    take(n = 1) {
      refill();
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
    tokens() {
      refill();
      return tokens;
    },
  };
}
