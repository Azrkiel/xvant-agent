const SECRET_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg']);
const SECRET_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
  'credentials.json',
  'secrets.json',
  'terraform.tfstate',
]);
/** Name-based exclusion runs before any read, so these files never enter memory. */
export function secretPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const name = segments.at(-1)!;
  return (
    segments.some((segment) => SECRET_SEGMENTS.has(segment)) ||
    SECRET_NAMES.has(name) ||
    (/^\.env(?:\.|$)/.test(name) &&
      !/\.(?:example|sample|template)$/.test(name)) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|gpg|asc)$/.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name)
  );
}
/** Defense in depth: known credential shapes. Absence does not prove a file is secret-free. */
const SECRET_CONTENT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
export function containsSecret(text: string): boolean {
  return SECRET_CONTENT.some((pattern) => pattern.test(text));
}
