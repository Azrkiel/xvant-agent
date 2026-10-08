// A cache that keeps at most `capacity` entries and drops the least recently
// used one first. Reading or writing a key makes it the most recent.
export function createLru(capacity) {
  if (!Number.isInteger(capacity) || capacity < 1)
    throw new RangeError('capacity must be a positive integer');
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > capacity) map.delete(map.keys().next().value);
    },
    has: (key) => map.has(key),
    size: () => map.size,
    // Keys from least to most recently used.
    keys: () => [...map.keys()],
  };
}
