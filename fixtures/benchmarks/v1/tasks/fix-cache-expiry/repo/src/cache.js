// A cache whose entries expire ttlMs milliseconds after they were set.
export function createCache(ttlMs, now = () => Date.now()) {
  const entries = new Map();
  return {
    set(key, value) {
      entries.set(key, { value, at: now() });
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ttlMs * 1000) return undefined;
      return entry.value;
    },
    has(key) {
      return entries.has(key);
    },
    size() {
      return entries.size;
    },
  };
}
