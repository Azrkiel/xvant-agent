import { parseTimestamp } from './timestamp.js';

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

// "2025-03-04T10:15:30-05:00 INFO api 123ms GET /users" becomes
// { time, level, service, latencyMs, message }. Returns null for a line that
// does not have that shape.
export function parseLine(line) {
  const match = /^(\S+) (\S+) (\S+) (\d+)ms(?: (.*))?$/.exec(line.trim());
  if (!match) return null;
  const time = parseTimestamp(match[1]);
  if (time === null || !LEVELS.includes(match[2])) return null;
  return {
    time,
    level: match[2],
    service: match[3],
    latencyMs: Number(match[4]),
    message: match[5] ?? '',
  };
}

export function parseLog(text) {
  return text
    .split('\n')
    .map(parseLine)
    .filter((entry) => entry !== null);
}
