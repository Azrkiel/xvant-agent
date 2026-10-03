import { containsSecret, secretPath } from '../packages/context/src/secrets.ts';

/** Licenses that allow private use and redistribution without copyleft terms. */
export const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Python-2.0',
  'Unlicense',
]);
/**
 * Also acceptable for development-only tools, which are run unmodified and
 * never shipped with XVANT: file-level copyleft does not reach our code.
 */
export const DEV_ONLY_LICENSES = new Set(['MPL-2.0']);
interface LockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  license?: string;
  link?: boolean;
  dev?: boolean;
}
export interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockPackage>;
}
/** Third-party entries only: workspace packages and their links are our own code. */
const installed = (lock: Lockfile) =>
  Object.entries(lock.packages ?? {}).filter(
    ([path, entry]) => path.includes('node_modules/') && !entry.link,
  );

/**
 * Every installed package must come from the npm registry over HTTPS with a
 * SHA-512 integrity hash, so `npm ci` installs exactly the reviewed bytes.
 */
export function lockfileProblems(lock: Lockfile): string[] {
  const problems: string[] = [];
  if ((lock.lockfileVersion ?? 0) < 3)
    problems.push('lockfileVersion must be 3 or later');
  const entries = installed(lock);
  if (!entries.length) problems.push('lockfile lists no installed packages');
  for (const [path, entry] of entries) {
    if (!entry.integrity?.startsWith('sha512-'))
      problems.push(path + ': no sha512 integrity hash');
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/'))
      problems.push(path + ': not resolved from the npm registry');
  }
  return problems;
}

/** A licence expression passes when any `OR` branch has every `AND` part allowed. */
function allowed(license: string, devOnly: boolean): boolean {
  const ok = (id: string) =>
    ALLOWED_LICENSES.has(id) || (devOnly && DEV_ONLY_LICENSES.has(id));
  return license
    .replace(/^\(|\)$/g, '')
    .split(/\s+OR\s+/)
    .some((branch) => branch.split(/\s+AND\s+/).every((id) => ok(id.trim())));
}
export function licenseProblems(lock: Lockfile): string[] {
  return installed(lock).flatMap(([path, entry]) =>
    !entry.license
      ? [path + ': no licence recorded']
      : allowed(entry.license, entry.dev === true)
        ? []
        : [path + ': licence ' + entry.license + ' is not on the allow list'],
  );
}

/**
 * Credential shapes and secret-bearing file names among tracked files.
 * Absence is not proof: this only catches known shapes.
 */
export function secretFindings(
  files: { path: string; text: string | null }[],
  /** Paths that hold deliberate fake credentials, e.g. tests of the detector. */
  expected: (path: string) => boolean,
): string[] {
  return files.flatMap(({ path, text }) =>
    expected(path)
      ? []
      : secretPath(path)
        ? [path + ': secret-bearing file name is tracked']
        : text !== null && containsSecret(text)
          ? [path + ': contains a credential-shaped string']
          : [],
  );
}

/** Every server in product code must bind the loopback address explicitly. */
export function listenProblems(
  files: { path: string; text: string }[],
): string[] {
  const problems: string[] = [];
  for (const { path, text } of files)
    text.split('\n').forEach((line, index) => {
      if (/\.listen\(/.test(line) && !line.includes("'127.0.0.1'"))
        problems.push(
          path + ':' + (index + 1) + ': listen() without the loopback address',
        );
    });
  return problems;
}
