import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

// A gate receipt names artifacts by path under a shared .artifacts directory
// that the next run overwrites. A bundle copies the exact bytes a receipt
// declares into a directory that is never rewritten.
const sha256 = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

type Declared = { path: string; sha256: string };
export type BundleEntry = {
  path: string;
  sha256: string | null;
  expected?: string;
  status: 'preserved' | 'mismatch' | 'missing';
};
export type Bundle = {
  bundleId: string;
  archivedAt: string;
  sourceRoot: string;
  receipt: { file: string; sha256: string; status: unknown };
  artifacts: BundleEntry[];
  extras: { path: string; sha256: string }[];
  integrity: 'complete' | 'partial';
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}
const portable = (path: string) => path.split(sep).join('/');
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel);
}

export function bundleId(
  receiptFile: string,
  receipt: Record<string, unknown>,
) {
  const name =
    typeof receipt.gateId === 'string'
      ? receipt.gateId
      : basename(receiptFile, '.json');
  const at = String(receipt.generatedAt ?? '').replace(/[^0-9TZ]/g, '');
  const source = String(receipt.sourceHash ?? receipt.dirtyTreeHash ?? '');
  if (!at || !/^[0-9a-f]{64}$/.test(source))
    throw new Error('Receipt lacks generatedAt or source hash');
  return `${name}-${at}-${source.slice(0, 12)}`;
}

export function archiveRun(options: {
  receiptFile: string;
  sourceRoot: string;
  destination: string;
  extras?: string[];
  now?: () => Date;
}): Bundle & { directory: string } {
  const sourceRoot = resolve(options.sourceRoot);
  const receiptBytes = readFileSync(options.receiptFile);
  const receipt = JSON.parse(receiptBytes.toString('utf8')) as Record<
    string,
    unknown
  >;
  const id = bundleId(options.receiptFile, receipt);
  const directory = resolve(options.destination, id);
  if (existsSync(directory)) throw new Error('Bundle already exists: ' + id);
  const staging = directory + '.partial';
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(join(staging, 'receipt.json'), receiptBytes);
    const declared = Array.isArray(receipt.artifacts)
      ? (receipt.artifacts as Declared[])
      : [];
    const artifacts: BundleEntry[] = declared.map(({ path, sha256: want }) => {
      const from = resolve(sourceRoot, path);
      if (!inside(sourceRoot, from)) throw new Error('Artifact escapes root');
      if (!existsSync(from))
        return { path, sha256: null, expected: want, status: 'missing' };
      const bytes = readFileSync(from);
      const got = sha256(bytes);
      if (got !== want)
        return { path, sha256: got, expected: want, status: 'mismatch' };
      const to = join(staging, 'artifacts', path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, bytes);
      return { path, sha256: got, status: 'preserved' };
    });
    const extras: Bundle['extras'] = [];
    for (const extra of options.extras ?? []) {
      const from = resolve(sourceRoot, extra);
      if (!inside(sourceRoot, from)) throw new Error('Extra escapes root');
      const name = portable(relative(sourceRoot, from));
      cpSync(from, join(staging, 'extras', name), { recursive: true });
      const copied = statSync(from).isDirectory()
        ? files(join(staging, 'extras', name))
        : [join(staging, 'extras', name)];
      for (const file of copied)
        extras.push({
          path: portable(relative(join(staging, 'extras'), file)),
          sha256: sha256(readFileSync(file)),
        });
    }
    const bundle: Bundle = {
      bundleId: id,
      archivedAt: (options.now ?? (() => new Date()))().toISOString(),
      sourceRoot: portable(sourceRoot),
      receipt: {
        file: portable(resolve(options.receiptFile)),
        sha256: sha256(receiptBytes),
        status: receipt.status,
      },
      artifacts,
      extras: extras.sort((a, b) => a.path.localeCompare(b.path)),
      integrity: artifacts.every((a) => a.status === 'preserved')
        ? 'complete'
        : 'partial',
    };
    writeFileSync(
      join(staging, 'bundle.json'),
      JSON.stringify(bundle, null, 2) + '\n',
    );
    for (const file of files(staging)) chmodSync(file, 0o444);
    renameSync(staging, directory);
    return { ...bundle, directory };
  } catch (error) {
    for (const file of existsSync(staging) ? files(staging) : [])
      chmodSync(file, 0o644);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function verifyBundle(directory: string): {
  bundle: Bundle;
  problems: string[];
} {
  const bundle = JSON.parse(
    readFileSync(join(directory, 'bundle.json'), 'utf8'),
  ) as Bundle;
  const problems: string[] = [];
  const check = (path: string, want: string | null) => {
    if (!existsSync(path)) problems.push('missing ' + path);
    else if (sha256(readFileSync(path)) !== want)
      problems.push('altered ' + path);
  };
  check(join(directory, 'receipt.json'), bundle.receipt.sha256);
  const receipt = JSON.parse(
    readFileSync(join(directory, 'receipt.json'), 'utf8'),
  ) as { artifacts?: Declared[] };
  const declared = new Map(
    (receipt.artifacts ?? []).map((a) => [a.path, a.sha256]),
  );
  for (const artifact of bundle.artifacts) {
    if (artifact.status !== 'preserved') continue;
    if (declared.get(artifact.path) !== artifact.sha256)
      problems.push('receipt disagrees ' + artifact.path);
    check(join(directory, 'artifacts', artifact.path), artifact.sha256);
  }
  for (const extra of bundle.extras)
    check(join(directory, 'extras', extra.path), extra.sha256);
  const expected =
    bundle.artifacts.every((a) => a.status === 'preserved') &&
    bundle.artifacts.length === declared.size
      ? 'complete'
      : 'partial';
  if (bundle.integrity !== expected)
    problems.push('integrity label is ' + bundle.integrity);
  return { bundle, problems };
}
