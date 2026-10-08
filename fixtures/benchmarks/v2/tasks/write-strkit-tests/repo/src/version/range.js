import { compareVersions } from './compare.js';
import { parseVersion } from './parse.js';

// ^1.2.3 means >=1.2.3 <2.0.0, ^0.2.3 means >=0.2.3 <0.3.0 and ^0.0.3 means exactly 0.0.3.
export function satisfiesCaret(version, base) {
  const b = parseVersion(base);
  if (compareVersions(version, base) < 0) return false;
  const v = parseVersion(version);
  if (b.major > 0) return v.major === b.major;
  if (b.minor > 0) return v.major === 0 && v.minor === b.minor;
  return v.major === 0 && v.minor === 0 && v.patch === b.patch;
}
