const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

// Milliseconds at UTC midnight for a real YYYY-MM-DD date, otherwise null.
export function parseDay(text) {
  const match = typeof text === 'string' ? DAY.exec(text) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  const real =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return real ? ms : null;
}

// Whole days from start to end; both must be valid days.
export function nightsBetween(start, end) {
  return Math.round((parseDay(end) - parseDay(start)) / DAY_MS);
}
