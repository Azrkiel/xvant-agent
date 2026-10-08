// Turns text into a URL slug: lowercase ASCII letters and digits separated by
// single hyphens. Accents are dropped (é becomes e). With maxLength the slug
// is cut to that length without leaving a hyphen at the end.
export function slugify(text, { maxLength = Infinity } = {}) {
  const base = String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= maxLength) return base;
  return base.slice(0, maxLength).replace(/-+$/, '');
}
