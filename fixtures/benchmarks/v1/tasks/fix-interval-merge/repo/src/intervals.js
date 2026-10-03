// Intervals are half-open: [start, end).
export function overlaps(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

export function merge(intervals) {
  const sorted = [...intervals].sort((x, y) => x.start - y.start);
  const out = [];
  for (const current of sorted) {
    const last = out.at(-1);
    if (last && overlaps(last, current)) last.end = current.end;
    else out.push({ ...current });
  }
  return out;
}
