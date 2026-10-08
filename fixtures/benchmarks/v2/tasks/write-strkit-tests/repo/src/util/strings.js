// Splits text into words, ignoring any amount of whitespace between and around them.
export const words = (text) => String(text).split(/\s+/).filter(Boolean);
