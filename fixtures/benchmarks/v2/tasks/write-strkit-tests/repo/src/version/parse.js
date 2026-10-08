const PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

// "1.2.3-beta.2" becomes { major: 1, minor: 2, patch: 3, pre: ['beta', '2'] }.
export function parseVersion(text) {
  const match = PATTERN.exec(String(text));
  if (!match) throw new SyntaxError('invalid version: ' + text);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}
