// ["a", "b"] becomes ["1: a", "2: b"].
export function renderLines(lines) {
  return lines.map((line, i) => i + 1 + ': ' + line);
}
