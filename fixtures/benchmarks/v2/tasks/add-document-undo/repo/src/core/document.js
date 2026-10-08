import { deleteLine, insertLine, replaceLine } from './buffer.js';

// A document holds lines of text. Line numbers start at 1; an edit with a
// bad line number throws a RangeError and changes nothing.
export function createDocument(initial = []) {
  let lines = [...initial];
  return {
    lines: () => [...lines],
    text: () => lines.join('\n'),
    insert(n, text) {
      lines = insertLine(lines, n, text);
    },
    delete(n) {
      lines = deleteLine(lines, n);
    },
    replace(n, text) {
      lines = replaceLine(lines, n, text);
    },
  };
}
