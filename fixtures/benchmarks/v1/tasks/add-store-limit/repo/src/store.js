export function createStore() {
  const data = new Map();
  return {
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value);
    },
    keys: () => [...data.keys()],
  };
}
