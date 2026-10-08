// Pure operations on an array of lines. Line numbers start at 1 and every
// function returns a new array.
function check(n, max) {
  if (!Number.isInteger(n)) throw new RangeError('line number must be an integer');
  if (n < 1 || n > max) throw new RangeError('line ' + n + ' is out of range');
}

export function insertLine(lines, n, text) {
  check(n, lines.length + 1);
  return [...lines.slice(0, n - 1), text, ...lines.slice(n - 1)];
}

export function deleteLine(lines, n) {
  check(n, lines.length);
  return [...lines.slice(0, n - 1), ...lines.slice(n)];
}

export function replaceLine(lines, n, text) {
  check(n, lines.length);
  return [...lines.slice(0, n - 1), text, ...lines.slice(n)];
}
