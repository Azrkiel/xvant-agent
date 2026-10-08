import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { Store } from './store.ts';

// Backup and restore of a state directory: state.sqlite and objects/. The
// runs/ directory holds git worktrees that belong to their repositories and is
// deliberately left out.
//
// Ownership: the store's lease lives in the database (the `ownership` row for
// 'controller'; see Store). A backup opens a Store, so it takes that lease for
// its whole duration and Store throws LEASE_BUSY when another live owner holds
// it. A restore may not open the target (it is about to be moved aside), so it
// reads the same row without writing and refuses while it is unexpired.
export const BACKUP_FORMAT = 1;
export const MANIFEST_FILE = 'manifest.json';
const DATABASE = 'state.sqlite';
const EXCLUDED_NOTE =
  'runs/ is not backed up: it holds git worktrees that belong to the repositories they were created from.';

export class BackupError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? code + ': ' + detail : code);
    this.code = code;
    this.name = 'BackupError';
  }
}

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const objectName = /^[a-f0-9]{64}$/;
const filePath = z
  .string()
  .regex(new RegExp('^(' + DATABASE + '|objects/[a-f0-9]{64})$'));
const manifestSchema = z.strictObject({
  formatVersion: z.literal(BACKUP_FORMAT),
  createdAt: z.string(),
  xvantVersion: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  excluded: z.array(z.strictObject({ path: z.string(), reason: z.string() })),
  files: z.array(
    z.strictObject({
      path: filePath,
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
export type BackupManifest = z.infer<typeof manifestSchema>;

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');
const quote = (path: string) => "'" + path.replace(/'/g, "''") + "'";
function isEmptyDirectory(path: string): boolean {
  return readdirSync(path).length === 0;
}
function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !/^[a-zA-Z]:/.test(rel));
}
function write(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx' });
}
function checkIntegrity(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return db.pragma('integrity_check', { simple: true }) as string;
  } finally {
    db.close();
  }
}

export interface BackupResult {
  directory: string;
  manifest: BackupManifest;
}

export function backupState(options: {
  home: string;
  out: string;
  xvantVersion: string;
  now?: () => Date;
}): BackupResult {
  const home = resolve(options.home);
  const out = resolve(options.out);
  const now = options.now ?? (() => new Date());
  if (!existsSync(join(home, DATABASE)))
    throw new BackupError('NO_STATE', home);
  if (inside(home, out)) throw new BackupError('OUT_INSIDE_STATE', out);
  if (existsSync(out) && !isEmptyDirectory(out))
    throw new BackupError('OUT_NOT_EMPTY', out);
  const staging = out + '.partial-' + process.pid;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  let store: Store | undefined;
  try {
    try {
      store = new Store(join(home, DATABASE), { owner: 'xvant-backup' });
    } catch (error) {
      if ((error as { code?: string }).code === 'LEASE_BUSY')
        throw new BackupError(
          'STORE_BUSY',
          'another XVANT process owns this state directory; stop it and retry',
        );
      throw error;
    }
    const schemaVersion = store.schemaVersion();
    // VACUUM INTO writes one transaction-consistent snapshot, WAL included.
    const target = join(staging, DATABASE);
    const source = new Database(join(home, DATABASE), { readonly: true });
    try {
      source.exec('VACUUM INTO ' + quote(target));
    } finally {
      source.close();
    }
    // The snapshot carries our own live lease; release it so the restored
    // database does not look owned, and leave it as one file without a WAL.
    const copy = new Database(target);
    try {
      copy.prepare('UPDATE ownership SET expires=0').run();
      copy.pragma('journal_mode=DELETE');
      const verdict = copy.pragma('integrity_check', { simple: true });
      if (verdict !== 'ok')
        throw new BackupError('SNAPSHOT_CORRUPT', String(verdict));
    } finally {
      copy.close();
    }
    const files: BackupManifest['files'] = [];
    const record = (path: string, bytes: Buffer) =>
      files.push({ path, size: bytes.length, sha256: sha256(bytes) });
    record(DATABASE, readFileSync(target));
    const objects = join(home, 'objects');
    if (existsSync(objects))
      for (const name of readdirSync(objects).sort()) {
        // Interrupted writes (.tmp-*) are not content.
        if (!objectName.test(name)) continue;
        const item = join(objects, name);
        if (!lstatSync(item).isFile())
          throw new BackupError('UNSAFE_OBJECT', name);
        const bytes = readFileSync(item);
        if (sha256(bytes) !== name)
          throw new BackupError('OBJECT_CORRUPT', name);
        write(join(staging, 'objects', name), bytes);
        record('objects/' + name, bytes);
      }
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT,
      createdAt: now().toISOString(),
      xvantVersion: options.xvantVersion,
      schemaVersion,
      excluded: [{ path: 'runs', reason: EXCLUDED_NOTE }],
      files,
    };
    writeFileSync(
      join(staging, MANIFEST_FILE),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    store.close();
    store = undefined;
    if (existsSync(out)) rmdirSync(out);
    renameSync(staging, out);
    return { directory: out, manifest };
  } catch (error) {
    store?.close();
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Read the manifest and check every listed file by size and SHA-256. */
export function verifyBackup(from: string): BackupManifest {
  const directory = resolve(from);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(directory, MANIFEST_FILE), 'utf8'));
  } catch {
    throw new BackupError('MANIFEST_MISSING', directory);
  }
  const version = (raw as { formatVersion?: unknown } | null)?.formatVersion;
  if (version !== BACKUP_FORMAT)
    throw new BackupError(
      'UNSUPPORTED_FORMAT',
      'backup format ' +
        String(version) +
        ', this XVANT reads ' +
        BACKUP_FORMAT,
    );
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new BackupError('MANIFEST_INVALID');
  const manifest = parsed.data;
  if (!manifest.files.some((f) => f.path === DATABASE))
    throw new BackupError('MANIFEST_INVALID', 'no database listed');
  if (new Set(manifest.files.map((f) => f.path)).size !== manifest.files.length)
    throw new BackupError('MANIFEST_INVALID', 'duplicate path');
  for (const file of manifest.files) {
    const path = join(directory, ...file.path.split('/'));
    if (!existsSync(path)) throw new BackupError('FILE_MISSING', file.path);
    const bytes = readFileSync(path);
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
      throw new BackupError('FILE_CORRUPT', file.path);
  }
  return manifest;
}

/** True while another process holds an unexpired lease on the database. */
function leaseHeld(database: string, now: number): boolean {
  let db: Database.Database;
  try {
    db = new Database(database, { readonly: true, fileMustExist: true });
  } catch {
    return false;
  }
  try {
    const row = db
      .prepare("SELECT expires FROM ownership WHERE resource='controller'")
      .get() as { expires: number } | undefined;
    return !!row && row.expires > now;
  } catch {
    // No ownership table: never opened by a Store, so nobody owns it.
    return false;
  } finally {
    db.close();
  }
}

export interface RestoreResult {
  home: string;
  manifest: BackupManifest;
  integrity: string;
  movedAside: string | null;
}

export function restoreState(options: {
  from: string;
  home: string;
  force?: boolean;
  now?: () => Date;
}): RestoreResult {
  const home = resolve(options.home);
  const from = resolve(options.from);
  const now = options.now ?? (() => new Date());
  // Nothing below touches the target until the whole backup has verified.
  const manifest = verifyBackup(from);
  const exists = existsSync(home);
  const occupied = exists && !isEmptyDirectory(home);
  if (occupied && !options.force)
    throw new BackupError(
      'TARGET_NOT_EMPTY',
      home + ' has state; pass --force to move it aside and restore',
    );
  if (occupied && leaseHeld(join(home, DATABASE), now().getTime()))
    throw new BackupError(
      'STORE_BUSY',
      'another XVANT process owns this state directory; stop it and retry',
    );
  const suffix = stamp(now());
  const staging = home + '.restore-' + suffix;
  mkdirSync(dirname(home), { recursive: true });
  mkdirSync(staging);
  try {
    for (const file of manifest.files) {
      const bytes = readFileSync(join(from, ...file.path.split('/')));
      if (sha256(bytes) !== file.sha256)
        throw new BackupError('FILE_CORRUPT', file.path);
      write(join(staging, ...file.path.split('/')), bytes);
    }
    const staged = checkIntegrity(join(staging, DATABASE));
    if (staged !== 'ok') throw new BackupError('INTEGRITY_FAILED', staged);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  let movedAside: string | null = null;
  try {
    if (occupied) {
      movedAside = home + '.before-restore-' + suffix;
      renameSync(home, movedAside);
    } else if (exists) rmdirSync(home);
    renameSync(staging, home);
  } catch (error) {
    // Put the original back if only the second step failed.
    if (movedAside && !existsSync(home) && existsSync(movedAside))
      renameSync(movedAside, home);
    rmSync(staging, { recursive: true, force: true });
    throw new BackupError('SWAP_FAILED', (error as Error).message);
  }
  const integrity = checkIntegrity(join(home, DATABASE));
  if (integrity !== 'ok')
    throw new BackupError(
      'INTEGRITY_FAILED',
      integrity + (movedAside ? '; previous state is at ' + movedAside : ''),
    );
  return { home, manifest, integrity, movedAside };
}

export const describeBackup = (manifest: BackupManifest): string =>
  manifest.files.length +
  ' files (' +
  manifest.files.filter((f) => f.path !== DATABASE).length +
  ' objects), schema ' +
  manifest.schemaVersion +
  ', ' +
  manifest.excluded.map((e) => e.path + '/ excluded').join(', ');
