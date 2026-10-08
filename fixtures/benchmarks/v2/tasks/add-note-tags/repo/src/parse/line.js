import { words } from './tokens.js';

// Turns a typed line into a note: { text, done }.
export function parseNote(line) {
  const text = words(line).join(' ');
  if (!text) throw new TypeError('note text must not be empty');
  return { text, done: false };
}
