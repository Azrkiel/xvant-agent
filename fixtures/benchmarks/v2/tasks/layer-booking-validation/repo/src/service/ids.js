export function createSequence(prefix) {
  let n = 0;
  return () => prefix + (n += 1);
}
