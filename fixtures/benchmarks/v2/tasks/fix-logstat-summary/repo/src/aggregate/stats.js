// Nearest-rank percentile: the smallest value that at least p percent of the
// values are less than or equal to. Returns 0 for no values.
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length - 1)];
}
