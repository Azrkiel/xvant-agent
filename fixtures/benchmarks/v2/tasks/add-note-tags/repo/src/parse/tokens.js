// Splits a line into whitespace-separated words.
export function words(line) {
  return String(line).trim().split(/\s+/).filter(Boolean);
}
