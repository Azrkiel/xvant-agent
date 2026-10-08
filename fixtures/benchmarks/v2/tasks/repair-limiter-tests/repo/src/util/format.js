// A wait in milliseconds as text: 250ms, 2s, 1m 5s.
export function formatRetry(ms) {
  if (ms < 1000) return Math.max(0, Math.ceil(ms)) + 'ms';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const rest = seconds % 60;
  return Math.floor(seconds / 60) + 'm' + (rest ? ' ' + rest + 's' : '');
}
