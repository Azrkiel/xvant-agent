const pad = (n) => String(n).padStart(2, '0');

// The UTC hour an instant falls in, such as "2025-03-04T15:00Z".
export function hourBucket(ms) {
  const d = new Date(ms);
  return (
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    ':00Z'
  );
}
