import { words } from '../util/strings.js';

// Breaks text into lines of at most `width` characters, filling each line
// greedily. A word longer than the width gets a line of its own. Every line
// break in the text starts a new paragraph; a blank paragraph is kept as an
// empty line.
export function wrap(text, width) {
  if (!Number.isInteger(width) || width < 1)
    throw new RangeError('width must be a positive integer');
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of words(paragraph)) {
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}
