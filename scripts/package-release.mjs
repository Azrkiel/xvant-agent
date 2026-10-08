// Release packaging for local-v1 (P10.6). Usage: node scripts/package-release.mjs [--allow-dirty]
// Builds .artifacts/release/xvant-<version>-<short commit>-win-x64.zip from
// `git archive HEAD` without docs/ and .Codex/, plus SHA256SUMS and
// support-matrix.json/.md generated from package.json, the pinned routes in
// packages/contracts/src/live.ts and the receipts under docs/evidence. It
// re-hashes its own output and lists the archive before it reports success.
// Writes docs/evidence/P10-package.json (the archive itself is not committed).
// The archive holds the committed tree, never uncommitted changes; a dirty
// tree is refused unless --allow-dirty, and the receipt then says so.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { archiveRun, sourceHash } from './evidence-bundle.ts';
import { discoverRuntime } from '../packages/adapters/src/live/discover.ts';
import {
  LIVE_ROUTES,
  NATIVE_LOCAL_ROUTE,
} from '../packages/contracts/src/live.ts';

const args = process.argv.slice(2);
const root = resolve('.');
const gateId = 'P10-package';
// Not part of an install: planning documents, evidence and handoffs.
const EXCLUDED = ['docs', '.Codex'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (command, commandArgs) =>
  spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
const gitOut = (...command) => (run('git', command).stdout ?? '').trim();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const commit = gitOut('rev-parse', 'HEAD');
const shortCommit = gitOut('rev-parse', '--short=10', 'HEAD');
const name = `xvant-${pkg.version}-${shortCommit}-win-x64.zip`;
const outDir = resolve(root, '.artifacts', 'release');
const report = {
  gateId,
  status: 'failed',
  generatedAt: new Date().toISOString(),
  classification: 'offline',
  operatingSystem: platform() + ' ' + release(),
  executionHost: hostname(),
  nodeVersion: process.version,
  sourceHash: sourceHash(root),
  version: pkg.version,
  commit,
  tree: gitOut('rev-parse', 'HEAD^{tree}'),
  excluded: EXCLUDED,
  dirty: false,
  dirtyFiles: [],
  // Not `artifacts`: archiveRun reads that name as files to copy into a bundle.
  outputs: [],
  limitations: [
    'The archive is the committed tree (git archive HEAD) without docs/ and .Codex/. It holds source, not node_modules or a build: install with Node 24.21.x and `npm ci`.',
    'The win-x64 name states the platform it was qualified on; the archive itself has no native binaries.',
    'Not signed. SHA256SUMS detects corruption, not a malicious replacement of both files.',
    'The support matrix lists what was qualified on this host at the receipts named in it; it is not a promise for other versions or systems. Linux is deferred by the operator.',
  ],
  problems: [],
};

// File names from a zip's central directory (read from the end of the file).
function zipEntries(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('no end-of-central-directory record');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50)
      throw new Error('bad directory entry');
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    names.push(bytes.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra;
  }
  return names;
}

// A change in anything the archive carries makes it unreproducible from HEAD.
// Not gitOut: trimming would eat the first line's leading status column.
const dirtyFiles = run('git', ['status', '--porcelain'])
  .stdout.split('\n')
  .filter(Boolean)
  .map((line) => line.slice(3))
  .filter(
    (path) =>
      !EXCLUDED.some((dir) => path === dir || path.startsWith(dir + '/')),
  );
report.dirty = dirtyFiles.length > 0;
report.dirtyFiles = dirtyFiles;
if (report.dirty && !args.includes('--allow-dirty')) {
  console.error(
    'Refusing to package a dirty tree (' +
      dirtyFiles.length +
      ' change(s) outside docs/): commit them, or pass --allow-dirty.\n' +
      dirtyFiles.slice(0, 10).join('\n'),
  );
  process.exit(1);
}
if (report.dirty)
  report.limitations.push(
    'Packaged with --allow-dirty: the archive is HEAD and does NOT contain the ' +
      dirtyFiles.length +
      ' uncommitted change(s) listed in dirtyFiles.',
  );

// The latest receipt that names a version of each runtime.
const evidence = join(root, 'docs', 'evidence');
const receipts = readdirSync(evidence)
  .filter((f) => f.endsWith('.json'))
  .flatMap((file) => {
    try {
      return [
        { file, json: JSON.parse(readFileSync(join(evidence, file), 'utf8')) },
      ];
    } catch {
      return [];
    }
  });
const latest = (items) =>
  items.sort((a, b) =>
    String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? '')),
  )[0] ?? null;
function runtimeRow(kind, route) {
  const live = receipts.find((r) => r.file === `G03-${kind}-live.json`);
  const seen = latest(
    receipts
      .filter((r) => r.json.runtimes?.[kind]?.version)
      .map((r) => ({
        file: 'docs/evidence/' + r.file,
        generatedAt: r.json.generatedAt,
        status: r.json.runtimes[kind].status,
        version: r.json.runtimes[kind].version,
      })),
  );
  const found = kind in LIVE_ROUTES ? discoverRuntime(kind) : null;
  return {
    pinnedVersion: route.runtimeVersion,
    adapter: route.adapterVersion,
    transport: route.transport,
    qualifiedByReceipt: live && {
      file: 'docs/evidence/' + live.file,
      status: live.json.status,
      generatedAt: live.json.generatedAt,
      runtimeVersion: live.json.runtimeVersion,
    },
    latestObservedInReceipts: seen,
    observedAtPackaging: found && {
      status: found.status,
      version: found.version ?? null,
    },
  };
}
const g00 = receipts.find((r) => r.file === 'G00.json')?.json;
const native = receipts.find((r) => r.file === 'G08-live-native.json');
const matrix = {
  generatedAt: report.generatedAt,
  product: { name: pkg.name, version: pkg.version, release: 'local-v1' },
  commit,
  platform: {
    supported: 'Windows x64, trusted-local',
    qualifiedOn: platform() + ' ' + release(),
    linux: 'deferred',
  },
  node: {
    engines: pkg.engines.node,
    pinned: readFileSync(join(root, '.node-version'), 'utf8').trim(),
    packagedWith: process.version,
  },
  packageManager: pkg.packageManager,
  git: g00?.gitVersion ?? gitOut('--version'),
  sqlite: g00?.sqliteVersion ?? null,
  dependencies: pkg.dependencies,
  runtimes: {
    ...Object.fromEntries(
      Object.entries(LIVE_ROUTES).map(([kind, route]) => [
        kind,
        runtimeRow(kind, route),
      ]),
    ),
    'native-local': {
      pinnedVersion: NATIVE_LOCAL_ROUTE.runtimeVersion,
      adapter: NATIVE_LOCAL_ROUTE.adapterVersion,
      transport: NATIVE_LOCAL_ROUTE.transport,
      qualifiedByReceipt: native && {
        file: 'docs/evidence/' + native.file,
        status: native.json.status,
        generatedAt: native.json.generatedAt,
      },
    },
  },
  notes: [
    'Runtimes update themselves. A later patch of a plain major.minor.patch pin is accepted and recorded as used; a prerelease pin must match exactly (see versionAccepted in packages/contracts/src/live.ts).',
    'latestObservedInReceipts and observedAtPackaging are what discovery found, not what was qualified; only qualifiedByReceipt is a live qualification.',
  ],
};
const md = [
  `# XVANT ${pkg.version} (local-v1) support matrix`,
  '',
  `Commit ${commit}. Generated ${report.generatedAt}. Windows x64, trusted-local; Linux is deferred.`,
  '',
  `- Qualified on: ${matrix.platform.qualifiedOn}`,
  `- Node: ${matrix.node.engines} (pinned ${matrix.node.pinned})`,
  `- Package manager: ${matrix.packageManager}`,
  `- Git: ${matrix.git}; SQLite: ${matrix.sqlite ?? 'unknown'}`,
  '',
  '| Runtime | Pinned | Adapter | Transport | Live receipt | Seen in receipts | Seen at packaging |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...Object.entries(matrix.runtimes).map(([kind, r]) => {
    const live = r.qualifiedByReceipt
      ? `${r.qualifiedByReceipt.status} ${String(r.qualifiedByReceipt.generatedAt ?? '').slice(0, 10)}`
      : 'none';
    const seen = r.latestObservedInReceipts
      ? `${r.latestObservedInReceipts.version} (${r.latestObservedInReceipts.status})`
      : '-';
    const now = r.observedAtPackaging
      ? `${r.observedAtPackaging.version ?? '-'} (${r.observedAtPackaging.status})`
      : '-';
    return `| ${kind} | ${r.pinnedVersion} | ${r.adapter} | ${r.transport} | ${live} | ${seen} | ${now} |`;
  }),
  '',
  ...matrix.notes.map((n) => '- ' + n),
  '',
].join('\n');

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, name);
rmSync(zipPath, { force: true });
const archived = run('git', [
  'archive',
  '--format=zip',
  `--prefix=xvant-${pkg.version}/`,
  '-o',
  zipPath,
  'HEAD',
  '--',
  '.',
  ...EXCLUDED.map((dir) => `:(exclude)${dir}`),
]);
if (archived.status !== 0)
  report.problems.push('git archive failed: ' + archived.stderr.trim());
writeFileSync(
  join(outDir, 'support-matrix.json'),
  JSON.stringify(matrix, null, 2) + '\n',
);
writeFileSync(join(outDir, 'support-matrix.md'), md);
const names = [name, 'support-matrix.json', 'support-matrix.md'];
if (!report.problems.length) {
  writeFileSync(
    join(outDir, 'SHA256SUMS'),
    names
      .map((n) => sha256(readFileSync(join(outDir, n))) + ' *' + n)
      .join('\n') + '\n',
  );
  // Verify from disk, as a user would: parse SHA256SUMS and re-hash each file.
  const sums = readFileSync(join(outDir, 'SHA256SUMS'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => /^([0-9a-f]{64}) \*(.+)$/.exec(line));
  for (const m of sums) {
    if (!m) {
      report.problems.push('SHA256SUMS has a malformed line');
      continue;
    }
    const bytes = readFileSync(join(outDir, m[2]));
    if (sha256(bytes) !== m[1])
      report.problems.push('hash mismatch after writing: ' + m[2]);
    report.outputs.push({ name: m[2], size: bytes.length, sha256: m[1] });
  }
  // The archive must hold exactly the committed files outside the excluded directories.
  const expected = gitOut('ls-tree', '-r', '--name-only', 'HEAD')
    .split('\n')
    .filter(Boolean)
    .filter(
      (p) => !EXCLUDED.some((dir) => p === dir || p.startsWith(dir + '/')),
    )
    .map((p) => `xvant-${pkg.version}/${p}`)
    .sort();
  try {
    const entries = zipEntries(readFileSync(zipPath))
      .filter((l) => !l.endsWith('/'))
      .sort();
    report.entries = entries.length;
    const missing = expected.filter((p) => !entries.includes(p));
    const extra = entries.filter((p) => !expected.includes(p));
    if (missing.length || extra.length)
      report.problems.push(
        `archive differs from HEAD: ${missing.length} missing, ${extra.length} extra`,
      );
    if (entries.some((p) => /\/(docs|\.Codex)\//.test(p)))
      report.problems.push('archive contains docs/ or .Codex/');
    if (!entries.includes(`xvant-${pkg.version}/scripts/xvant.mjs`))
      report.problems.push('archive lacks scripts/xvant.mjs');
  } catch (error) {
    report.problems.push('Cannot read the archive: ' + error.message);
  }
}
report.archive = {
  name,
  bytes: statSync(zipPath, { throwIfNoEntry: false })?.size ?? 0,
};
report.supportMatrix = 'support-matrix.json';
if (sourceHash(root) !== report.sourceHash)
  report.problems.push('Source changed during the run');
report.status = report.problems.length === 0 ? 'passed' : 'failed';
mkdirSync(evidence, { recursive: true });
const receiptFile = join(evidence, gateId + '.json');
writeFileSync(receiptFile, JSON.stringify(report, null, 2) + '\n');
console.log(gateId + ': ' + report.status);
for (const a of report.outputs)
  console.log(
    a.sha256.slice(0, 12) + '  ' + String(a.size).padStart(9) + '  ' + a.name,
  );
if (report.problems.length) console.log(report.problems.join('\n'));
process.exitCode = report.status === 'passed' ? 0 : 1;
try {
  const bundle = archiveRun({
    receiptFile,
    sourceRoot: root,
    destination: join(evidence, 'runs'),
  });
  console.log('evidence bundle: ' + bundle.bundleId + ' ' + bundle.integrity);
} catch (error) {
  console.error('Evidence archival failed: ' + error.message);
  process.exitCode = 1;
}
