import { parseVersion } from './parse.js';

const numeric = (id) => /^\d+$/.test(id);

function comparePre(a, b) {
  // A release is greater than any prerelease of the same version.
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0;
    return a.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    const an = numeric(a[i]);
    const bn = numeric(b[i]);
    if (an && bn) return Number(a[i]) < Number(b[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// -1, 0 or 1 following semantic versioning precedence.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const part of ['major', 'minor', 'patch']) {
    if (x[part] !== y[part]) return x[part] < y[part] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}
