export function createRooms(names) {
  const known = new Set(names);
  return {
    has: (name) => known.has(name),
    names: () => [...known].sort(),
  };
}
