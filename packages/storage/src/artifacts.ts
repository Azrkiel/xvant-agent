import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { z } from 'zod';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
function fail(code: string): never {
  throw new Error(code);
}
/** Reject links in every existing component, including junctions on Windows. */
export function safePath(path: string): string {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) fail('UNSAFE_PATH');
    } else {
      // lstat catches dangling symlinks, which existsSync follows.
      try {
        if (lstatSync(current).isSymbolicLink()) fail('UNSAFE_PATH');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return absolute;
}
function regularBytes(path: string): Buffer {
  safePath(path);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) fail('UNSAFE_PATH');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      before.ino !== opened.ino ||
      before.dev !== opened.dev
    )
      fail('UNSAFE_PATH');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function durableWrite(path: string, bytes: Buffer): void {
  safePath(path);
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function flushDirectory(path: string): void {
  // Windows does not expose portable directory fsync through Node.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export class ArtifactStore {
  readonly #root: string;
  constructor(path: string) {
    this.#root = safePath(path);
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#assertRoot();
  }
  #assertRoot(): void {
    safePath(this.#root);
    if (
      !lstatSync(this.#root).isDirectory() ||
      realpathSync(this.#root) !== this.#root
    )
      fail('UNSAFE_PATH');
  }
  put(bytes: Buffer): string {
    this.#assertRoot();
    const hash = digest(bytes);
    const target = join(this.#root, hash);
    if (existsSync(target)) {
      this.get(hash);
      return hash;
    }
    const temporary = join(this.#root, `.tmp-${randomUUID()}`);
    try {
      durableWrite(temporary, bytes);
      this.#assertRoot();
      // Objects are immutable. Concurrent writers of the same hash have identical bytes.
      if (existsSync(target)) this.get(hash);
      else renameSync(temporary, target);
      flushDirectory(this.#root);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return hash;
  }
  get(hash: string): Buffer {
    if (!hashSchema.safeParse(hash).success) fail('INVALID_HASH');
    this.#assertRoot();
    const bytes = regularBytes(join(this.#root, hash));
    if (digest(bytes) !== hash) fail('ARTIFACT_CORRUPT');
    return bytes;
  }
  hashes(): string[] {
    this.#assertRoot();
    const names = readdirSync(this.#root);
    for (const name of names)
      if (
        !hashSchema.safeParse(name).success &&
        !/^\.tmp-[0-9a-f-]{36}$/.test(name)
      )
        fail('UNEXPECTED_ARTIFACT');
    return names.filter((name) => hashSchema.safeParse(name).success).sort();
  }
}
const manifestSchema = z.strictObject({
  version: z.literal(1),
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  database: z.strictObject({
    file: z.literal('state.sqlite'),
    sha256: hashSchema,
  }),
  artifacts: z
    .array(hashSchema)
    .max(1000000)
    .refine((values) => new Set(values).size === values.length),
});
const tables: Record<string, string[]> = {
  tasks: ['id', 'project_id', 'body'],
  commands: ['project_id', 'kind', 'key', 'hash', 'result'],
  events: ['sequence', 'task_id', 'kind', 'payload'],
  operations: ['id', 'task_id', 'body'],
  outbox: ['operation_id', 'status'],
  ownership: ['resource', 'owner', 'generation', 'expires'],
  reservations: ['resource', 'operation_id'],
  evidence: ['task_id', 'body'],
  artifacts: ['hash', 'task_id', 'work_revision'],
  provider_connections: ['id', 'task_id', 'body'],
  provider_entries: ['sequence', 'connection_id', 'body'],
  provider_reservations: ['resource', 'connection_id'],
  memory_records: [
    'project_id',
    'id',
    'namespace',
    'status',
    'proposal_hash',
    'body',
  ],
};
const primaryKeys: Record<string, string[]> = {
  tasks: ['id'],
  commands: ['project_id', 'kind', 'key'],
  events: ['sequence'],
  operations: ['id'],
  outbox: ['operation_id'],
  ownership: ['resource'],
  reservations: ['resource'],
  evidence: ['task_id'],
  artifacts: ['hash', 'task_id', 'work_revision'],
  provider_connections: ['id'],
  provider_entries: ['sequence'],
  provider_reservations: ['resource'],
  memory_records: ['project_id', 'id'],
};
const integerColumns = new Set([
  'events.sequence',
  'ownership.generation',
  'ownership.expires',
  'artifacts.work_revision',
  'provider_entries.sequence',
]);
const foreignKeys: Record<string, { from: string; table: string }[]> = {
  tasks: [],
  commands: [],
  ownership: [],
  events: [{ from: 'task_id', table: 'tasks' }],
  operations: [{ from: 'task_id', table: 'tasks' }],
  outbox: [{ from: 'operation_id', table: 'operations' }],
  reservations: [{ from: 'operation_id', table: 'operations' }],
  evidence: [{ from: 'task_id', table: 'tasks' }],
  artifacts: [{ from: 'task_id', table: 'tasks' }],
  provider_connections: [{ from: 'task_id', table: 'tasks' }],
  provider_entries: [{ from: 'connection_id', table: 'provider_connections' }],
  provider_reservations: [
    { from: 'connection_id', table: 'provider_connections' },
  ],
  memory_records: [],
};
interface ColumnMetadata {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: unknown;
}
interface ForeignKeyMetadata {
  from: string;
  to: string;
  table: string;
  on_update: string;
  on_delete: string;
  match: string;
}
function validateTable(
  db: Database.Database,
  table: string,
  columns: string[],
): void {
  const object = db
    .prepare('SELECT type FROM sqlite_schema WHERE name=?')
    .get(table) as { type: string } | undefined;
  if (object?.type !== 'table') fail('SCHEMA_UNSUPPORTED');
  const actual = db.pragma(`table_info(${table})`) as ColumnMetadata[];
  const keys = primaryKeys[table]!;
  const expected = columns.map((name) => ({
    name,
    type: integerColumns.has(`${table}.${name}`) ? 'INTEGER' : 'TEXT',
    // SQLite reports implicit single-column PKs as nullable in this v1 schema.
    notnull: keys.length === 1 && keys[0] === name ? 0 : 1,
    pk: keys.indexOf(name) + 1,
    dflt_value: null,
  }));
  const metadata = actual.map(({ name, type, notnull, pk, dflt_value }) => ({
    name,
    type,
    notnull,
    pk,
    dflt_value,
  }));
  if (JSON.stringify(metadata) !== JSON.stringify(expected))
    fail('SCHEMA_UNSUPPORTED');
  const actualForeignKeys = (
    db.pragma(`foreign_key_list(${table})`) as ForeignKeyMetadata[]
  ).map(({ from, table, to, on_update, on_delete, match }) => ({
    from,
    table,
    to,
    on_update,
    on_delete,
    match,
  }));
  const expectedForeignKeys = foreignKeys[table]!.map(({ from, table }) => ({
    from,
    table,
    to: 'id',
    on_update: 'NO ACTION',
    on_delete: 'NO ACTION',
    match: 'NONE',
  }));
  if (JSON.stringify(actualForeignKeys) !== JSON.stringify(expectedForeignKeys))
    fail('SCHEMA_UNSUPPORTED');
  // Every current conflict target is a PK. Validate its backing unique index,
  // while INTEGER PRIMARY KEY uses the rowid and has no separate index.
  const indexes = db.pragma(`index_list(${table})`) as Array<{
    origin: string;
    unique: number;
    partial: number;
  }>;
  const uniqueIndexes = indexes.filter((index) => index.unique === 1);
  if (
    table === 'events' || table === 'provider_entries'
      ? uniqueIndexes.length !== 0
      : uniqueIndexes.length !== 1 ||
        uniqueIndexes[0]?.origin !== 'pk' ||
        uniqueIndexes[0]?.partial !== 0
  )
    fail('SCHEMA_UNSUPPORTED');
}
function validateDatabase(path: string): {
  references: string[];
  schemaVersion: number;
} {
  regularBytes(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    if (![1, 2, 3].includes(schemaVersion)) fail('SCHEMA_UNSUPPORTED');
    if (
      db.pragma('integrity_check', { simple: true }) !== 'ok' ||
      (db.pragma('foreign_key_check') as unknown[]).length !== 0
    )
      fail('DATABASE_CORRUPT');
    for (const [table, columns] of Object.entries(tables)) {
      if (schemaVersion === 1 && table.startsWith('provider_')) continue;
      if (schemaVersion < 3 && table.startsWith('memory_')) continue;
      validateTable(db, table, columns);
    }
    if (schemaVersion >= 3) {
      const text = db
        .prepare("SELECT sql FROM sqlite_schema WHERE name='memory_text'")
        .get() as { sql: string } | undefined;
      if (text?.sql !== 'CREATE VIRTUAL TABLE memory_text USING fts5(content)')
        fail('SCHEMA_UNSUPPORTED');
    }
    const references = db
      .prepare('SELECT DISTINCT hash FROM artifacts')
      .all() as Array<{ hash: unknown }>;
    return {
      references: references.map(({ hash }) => hashSchema.parse(hash)),
      schemaVersion,
    };
  } finally {
    db.close();
  }
}
function newDestination(path: string): { target: string; parent: string } {
  const target = safePath(path);
  const parent = dirname(target);
  if (existsSync(target)) fail('DESTINATION_EXISTS');
  if (!lstatSync(parent).isDirectory()) fail('UNSAFE_PATH');
  return { target, parent };
}
function cleanupStage(stage: string, parent: string): void {
  safePath(parent);
  const rel = relative(parent, stage);
  if (
    isAbsolute(rel) ||
    rel.startsWith('..') ||
    rel.includes(sep) ||
    !basename(stage).startsWith('.snapshot-')
  )
    fail('UNSAFE_PATH');
  if (existsSync(stage)) {
    safePath(stage);
    rmSync(stage, { recursive: true, force: true });
  }
}
function publish(stage: string, target: string): void {
  newDestination(target);
  flushDirectory(stage);
  renameSync(stage, target);
  flushDirectory(dirname(target));
}
export async function backupSnapshot(
  store: { backup: (path: string) => Promise<void> },
  artifacts: ArtifactStore,
  destination: string,
): Promise<void> {
  const { target, parent } = newDestination(destination);
  const stage = mkdtempSync(join(parent, '.snapshot-'));
  try {
    const databasePath = join(stage, 'state.sqlite');
    await store.backup(databasePath);
    const { references, schemaVersion } = validateDatabase(databasePath);
    const dbBytes = regularBytes(databasePath);
    const fd = openSync(databasePath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Backup precedes enumeration. Retention plus artifact-before-reference publication
    // ensures every committed reference has an object; later artifacts are a safe superset.
    const hashes = artifacts.hashes();
    const included = new Set(hashes);
    if (references.some((hash) => !included.has(hash)))
      fail('ARTIFACT_MISSING');
    const copy = new ArtifactStore(join(stage, 'artifacts'));
    for (const hash of hashes) copy.put(artifacts.get(hash));
    const manifest = {
      version: 1,
      schemaVersion,
      database: { file: 'state.sqlite', sha256: digest(dbBytes) },
      artifacts: hashes,
    };
    durableWrite(
      join(stage, 'manifest.json'),
      Buffer.from(JSON.stringify(manifest)),
    );
    publish(stage, target);
  } finally {
    cleanupStage(stage, parent);
  }
}
export async function restoreSnapshot(
  source: string,
  destination: string,
): Promise<void> {
  const { target, parent } = newDestination(destination);
  safePath(source);
  const manifest = manifestSchema.parse(
    JSON.parse(regularBytes(join(source, 'manifest.json')).toString('utf8')),
  );
  const stage = mkdtempSync(join(parent, '.snapshot-'));
  try {
    const bytes = regularBytes(join(source, manifest.database.file));
    if (digest(bytes) !== manifest.database.sha256) fail('DATABASE_CORRUPT');
    const databasePath = join(stage, 'state.sqlite');
    durableWrite(databasePath, bytes);
    const { references, schemaVersion } = validateDatabase(databasePath);
    if (schemaVersion !== manifest.schemaVersion) fail('SCHEMA_UNSUPPORTED');
    const included = new Set(manifest.artifacts);
    if (references.some((hash) => !included.has(hash)))
      fail('ARTIFACT_MISSING');
    // Read snapshot objects without creating or mutating source directories.
    const copy = new ArtifactStore(join(stage, 'artifacts'));
    for (const hash of manifest.artifacts) {
      const object = regularBytes(join(source, 'artifacts', hash));
      if (digest(object) !== hash) fail('ARTIFACT_CORRUPT');
      copy.put(object);
    }
    durableWrite(
      join(stage, 'manifest.json'),
      Buffer.from(JSON.stringify(manifest)),
    );
    publish(stage, target);
  } finally {
    cleanupStage(stage, parent);
  }
}
