import { hourBucket } from './buckets.js';
import { percentile } from './stats.js';

// One row per UTC hour and service, ordered by hour and then service name.
export function summarize(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const hour = hourBucket(entry.time);
    const key = hour + '\0' + entry.service;
    if (!groups.has(key)) groups.set(key, { hour, service: entry.service, items: [] });
    groups.get(key).items.push(entry);
  }
  return [...groups.values()]
    .sort((a, b) => (a.hour + a.service < b.hour + b.service ? -1 : 1))
    .map(({ hour, service, items }) => {
      const latencies = items.map((e) => e.latencyMs);
      return {
        hour,
        service,
        count: items.length,
        errors: items.filter((e) => e.level === 'ERROR').length,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
      };
    });
}
