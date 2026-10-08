import { systemClock } from '../util/clock.js';

// A cache whose entries expire. An entry lives for `ttlMs` from when it is set,
// or until the epoch time `expiresAt` when that is given; it is gone at that
// instant.
export function createTtlCache({ clock = systemClock, ttlMs = 60_000 } = {}) {
  const entries = new Map();
  const live = (entry) => clock.now() < entry.expiresAt;
  return {
    set(key, value, options = {}) {
      const ttl = options.ttlMs ?? ttlMs;
      entries.set(key, { value, expiresAt: options.expiresAt ?? clock.now() + ttl });
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (!live(entry)) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    // The number of entries that have not expired.
    size: () => [...entries.values()].filter(live).length,
  };
}
