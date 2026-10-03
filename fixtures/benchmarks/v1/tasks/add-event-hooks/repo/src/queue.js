export function createQueue() {
  const items = [];
  return {
    push(item) {
      items.push(item);
    },
    shift() {
      return items.shift();
    },
    size: () => items.length,
  };
}
