import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION, Store } from './store.ts';
import { ArtifactStore } from './artifacts.ts';
import {
  BackupError,
  backupState,
  restoreState,
  verifyBackup,
} from './backup.ts';

let root: string;
const home = () => join(root, 'home');
const input = (id: string) => ({
  id,
  projectId: 'project',
  objective: 'Build ' + id,
  requiredCheckIds: ['test'],
  acceptanceCriteria: ['Pass'],
});
const rows = (dir: string) => {
  const db = new Database(join(dir, 'state.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT id, body FROM tasks ORDER BY id').all();
  } finally {
    db.close();
  }
};
const objectFiles = (dir: string) =>
  Object.fromEntries(
    readdirSync(join(dir, 'objects')).map((n) => [
      n,
      readFileSync(join(dir, 'objects', n)).toString('hex'),
    ]),
  );
function populate(dir: string) {
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(dir, 'state.sqlite'), { owner: 'seed' });
  store.create('c1', input('one'));
  store.create('c2', input('two'));
  store.close();
  const objects = new ArtifactStore(join(dir, 'objects'));
  objects.put(Buffer.from('alpha'));
  objects.put(Buffer.from('beta'));
}
const capture = (fn: () => unknown): BackupError => {
  try {
    fn();
  } catch (error) {
    return error as BackupError;
  }
  throw new Error('expected a failure');
};
const backupOf = (out = join(root, 'backup')) =>
  backupState({ home: home(), out, xvantVersion: '9.9.9' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-backup-'));
  populate(home());
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('backup and restore', () => {
  it('round-trips rows and object bytes into an empty home', () => {
    const { manifest, directory } = backupOf();
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.xvantVersion).toBe('9.9.9');
    expect(manifest.excluded[0]?.path).toBe('runs');
    expect(manifest.files).toHaveLength(3);
    expect(existsSync(join(directory, 'state.sqlite-wal'))).toBe(false);
    const target = join(root, 'restored');
    const result = restoreState({ from: directory, home: target });
    expect(result.integrity).toBe('ok');
    expect(result.movedAside).toBeNull();
    expect(rows(target)).toEqual(rows(home()));
    expect(rows(target)).toHaveLength(2);
    expect(objectFiles(target)).toEqual(objectFiles(home()));
    // The restored state opens as a normal store: the snapshot's lease is released.
    const store = new Store(join(target, 'state.sqlite'), { owner: 'after' });
    expect(store.getTask('one').id).toBe('one');
    store.close();
  });

  it('does not copy runs/', () => {
    mkdirSync(join(home(), 'runs', 'x'), { recursive: true });
    writeFileSync(join(home(), 'runs', 'x', 'f'), 'worktree');
    const { directory } = backupOf();
    expect(existsSync(join(directory, 'runs'))).toBe(false);
  });

  it('refuses to back up while another live owner holds the store', () => {
    const holder = new Store(join(home(), 'state.sqlite'), { owner: 'ui' });
    try {
      expect(capture(() => backupOf()).code).toBe('STORE_BUSY');
      expect(existsSync(join(root, 'backup'))).toBe(false);
    } finally {
      holder.close();
    }
    expect(() => backupOf()).not.toThrow();
  });

  it('refuses a backup directory that already has content', () => {
    mkdirSync(join(root, 'backup'));
    writeFileSync(join(root, 'backup', 'keep'), 'x');
    expect(capture(() => backupOf()).code).toBe('OUT_NOT_EMPTY');
    expect(capture(() => backupOf(join(home(), 'b'))).code).toBe(
      'OUT_INSIDE_STATE',
    );
  });

  it('refuses a corrupted or missing file and leaves the target untouched', () => {
    const { directory, manifest } = backupOf();
    const target = join(root, 'target');
    const object = manifest.files.find((f) => f.path.startsWith('objects/'))!;
    const path = join(directory, ...object.path.split('/'));
    const good = readFileSync(path);
    writeFileSync(path, Buffer.from('tampered'));
    expect(
      capture(() => restoreState({ from: directory, home: target })).code,
    ).toBe('FILE_CORRUPT');
    expect(existsSync(target)).toBe(false);
    rmSync(path);
    expect(
      capture(() => restoreState({ from: directory, home: target })).code,
    ).toBe('FILE_MISSING');
    expect(existsSync(target)).toBe(false);
    writeFileSync(path, good);
    // A damaged database is caught the same way, even with --force over real state.
    writeFileSync(join(directory, 'state.sqlite'), 'not a database');
    const before = rows(home());
    expect(
      capture(() =>
        restoreState({ from: directory, home: home(), force: true }),
      ).code,
    ).toBe('FILE_CORRUPT');
    expect(rows(home())).toEqual(before);
    expect(readdirSync(root).filter((n) => n.includes('restore'))).toEqual([]);
  });

  it('refuses over existing state without --force', () => {
    const { directory } = backupOf();
    const before = rows(home());
    expect(
      capture(() => restoreState({ from: directory, home: home() })).code,
    ).toBe('TARGET_NOT_EMPTY');
    expect(rows(home())).toEqual(before);
  });

  it('with --force moves existing state aside instead of deleting it', () => {
    const { directory } = backupOf();
    const store = new Store(join(home(), 'state.sqlite'), { owner: 'more' });
    store.create('c3', input('three'));
    store.close();
    const result = restoreState({ from: directory, home: home(), force: true });
    expect(rows(home())).toHaveLength(2);
    expect(result.movedAside).toMatch(/home\.before-restore-/);
    expect(rows(result.movedAside!)).toHaveLength(3);
  });

  it('refuses --force while the existing state is owned by a live process', () => {
    const { directory } = backupOf();
    const holder = new Store(join(home(), 'state.sqlite'), { owner: 'ui' });
    try {
      expect(
        capture(() =>
          restoreState({ from: directory, home: home(), force: true }),
        ).code,
      ).toBe('STORE_BUSY');
    } finally {
      holder.close();
    }
    expect(rows(home())).toHaveLength(2);
  });

  it('refuses an unknown manifest version and malformed manifests', () => {
    const { directory } = backupOf();
    const path = join(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...manifest, formatVersion: 2 }));
    expect(capture(() => verifyBackup(directory)).code).toBe(
      'UNSUPPORTED_FORMAT',
    );
    const target = join(root, 'target');
    expect(
      capture(() => restoreState({ from: directory, home: target })).code,
    ).toBe('UNSUPPORTED_FORMAT');
    expect(existsSync(target)).toBe(false);
    writeFileSync(
      path,
      JSON.stringify({
        ...manifest,
        files: [{ path: '../escape', size: 1, sha256: 'a'.repeat(64) }],
      }),
    );
    expect(capture(() => verifyBackup(directory)).code).toBe(
      'MANIFEST_INVALID',
    );
    rmSync(path);
    expect(capture(() => verifyBackup(directory)).code).toBe(
      'MANIFEST_MISSING',
    );
  });
});

describe('upgrade rollback', () => {
  const UPGRADE = [
    { version: SCHEMA_VERSION + 1, sql: 'CREATE TABLE upgraded(x INTEGER)' },
  ];
  const schemaOf = (dir: string) => {
    const db = new Database(join(dir, 'state.sqlite'), { readonly: true });
    try {
      return db.pragma('user_version', { simple: true });
    } finally {
      db.close();
    }
  };

  it('restores the state from before an upgrade so the earlier version runs again', () => {
    const before = rows(home());
    backupOf();
    // The upgrade migrates the schema and the new version writes to it.
    const upgraded = new Store(join(home(), 'state.sqlite'), {
      owner: 'new-version',
      migrations: UPGRADE,
    });
    upgraded.create('c3', input('three'));
    upgraded.close();
    // The earlier version cannot open what the upgrade left behind.
    expect(
      () => new Store(join(home(), 'state.sqlite'), { owner: 'old-version' }),
    ).toThrow('SCHEMA_UNSUPPORTED');

    const restored = restoreState({
      from: join(root, 'backup'),
      home: home(),
      force: true,
    });
    const old = new Store(join(home(), 'state.sqlite'), {
      owner: 'old-version',
    });
    expect(old.schemaVersion()).toBe(SCHEMA_VERSION);
    old.close();
    expect(rows(home())).toEqual(before);
    // The upgraded state is kept beside it, not deleted.
    expect(schemaOf(restored.movedAside!)).toBe(SCHEMA_VERSION + 1);
    expect(rows(restored.movedAside!)).toHaveLength(3);
  });

  it('refuses a backup taken after an upgrade and leaves the state alone', () => {
    const upgraded = new Store(join(home(), 'state.sqlite'), {
      owner: 'new-version',
      migrations: UPGRADE,
    });
    upgraded.close();
    // Only the upgraded version can read this state, so it makes the backup.
    const out = join(root, 'newer');
    mkdirSync(join(out, 'objects'), { recursive: true });
    const db = new Database(join(home(), 'state.sqlite'));
    db.exec(
      "VACUUM INTO '" + join(out, 'state.sqlite').replace(/'/g, "''") + "'",
    );
    db.close();
    const bytes = readFileSync(join(out, 'state.sqlite'));
    writeFileSync(
      join(out, 'manifest.json'),
      JSON.stringify({
        formatVersion: 1,
        createdAt: new Date(0).toISOString(),
        xvantVersion: '9.9.9',
        schemaVersion: SCHEMA_VERSION + 1,
        excluded: [],
        files: [
          {
            path: 'state.sqlite',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      }),
    );
    const target = join(root, 'fresh');
    expect(capture(() => restoreState({ from: out, home: target })).code).toBe(
      'SCHEMA_UNSUPPORTED',
    );
    expect(existsSync(target)).toBe(false);
  });

  it('names the schema the store really writes', () => {
    expect(schemaOf(home())).toBe(SCHEMA_VERSION);
  });
});

it('carries the routing default, its history and candidates through a restore', () => {
  const routing = join(home(), 'routing');
  mkdirSync(join(routing, 'profiles'), { recursive: true });
  mkdirSync(join(routing, 'candidates'), { recursive: true });
  writeFileSync(join(routing, 'ledger.json'), '{"current":"default"}\n');
  writeFileSync(join(routing, 'profiles', 'default.json'), '{"p":1}\n');
  writeFileSync(join(routing, 'candidates', 'opus-1.json'), '{"c":1}\n');
  // An interrupted ledger write and a stray file are not content.
  writeFileSync(join(routing, 'ledger.json.1234.tmp'), 'partial');
  writeFileSync(join(routing, 'profiles', 'notes.txt'), 'x');
  const { manifest } = backupOf();
  expect(
    manifest.files.map((f) => f.path).filter((p) => p.startsWith('routing/')),
  ).toEqual([
    'routing/ledger.json',
    'routing/profiles/default.json',
    'routing/candidates/opus-1.json',
  ]);
  const target = join(root, 'restored');
  restoreState({ from: join(root, 'backup'), home: target });
  expect(readdirSync(join(target, 'routing')).sort()).toEqual([
    'candidates',
    'ledger.json',
    'profiles',
  ]);
  expect(
    readFileSync(join(target, 'routing', 'profiles', 'default.json'), 'utf8'),
  ).toBe('{"p":1}\n');
});

it('a restored database never arrives owned, whatever the backup claimed', () => {
  backupOf();
  // A backup from elsewhere claims a lease far in the future.
  const file = join(root, 'backup', 'state.sqlite');
  const db = new Database(file);
  db.prepare('UPDATE ownership SET expires=?').run(Date.now() + 3_600_000);
  db.pragma('journal_mode=DELETE');
  db.close();
  const bytes = readFileSync(file);
  const manifestFile = join(root, 'backup', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const entry = manifest.files.find(
    (f: { path: string }) => f.path === 'state.sqlite',
  );
  entry.size = bytes.length;
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const target = join(root, 'restored');
  restoreState({ from: join(root, 'backup'), home: target });
  const store = new Store(join(target, 'state.sqlite'), { owner: 'next' });
  store.close();
});
