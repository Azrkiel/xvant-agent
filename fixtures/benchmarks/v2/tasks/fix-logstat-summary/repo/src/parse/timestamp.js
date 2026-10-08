const PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

// Parses an ISO 8601 timestamp with a Z or +HH:MM / -HH:MM zone into epoch
// milliseconds. Returns null when the text is not such a timestamp.
export function parseTimestamp(text) {
  const match = PATTERN.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  let ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (match[7] !== 'Z') {
    const [offsetHours, offsetMinutes] = match[7].slice(1).split(':').map(Number);
    ms -= (offsetHours * 60 + offsetMinutes) * 60_000;
  }
  return ms;
}
