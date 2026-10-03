// Pages are numbered from 1.
export function paginate(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size);
}

export function pageCount(items, size) {
  return Math.floor(items.length / size);
}
