import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from './store.ts';
import { ArtifactStore, backupSnapshot, restoreSnapshot } from './artifacts.ts';
let root: string;
let store: Store;
let artifacts: ArtifactStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-artifacts-'));
  store = new Store(join(root, 'live.sqlite'), { owner: 'controller' });
  artifacts = new ArtifactStore(join(root, 'artifacts'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const task = {
  id: 'task',
  projectId: 'project',
  objective: 'Test',
  requiredCheckIds: ['test'],
  acceptanceCriteria: ['Pass'],
};
describe('content addressed artifacts', () => {
  it('durably stores identical bytes under one SHA256 filename', () => {
    const data = Buffer.from('evidence');
    const hash = artifacts.put(data);
    expect(hash).toBe(createHash('sha256').update(data).digest('hex'));
    expect(artifacts.put(data)).toBe(hash);
    expect(artifacts.get(hash)).toEqual(data);
    expect(readdirSync(join(root, 'artifacts'))).toEqual([hash]);
    expect(new ArtifactStore(join(root, 'artifacts')).get(hash)).toEqual(data);
  });
  it('rejects traversal, corruption, missing objects and symlink roots', () => {
    expect(() => artifacts.get('../live.sqlite')).toThrow();
    const hash = artifacts.put(Buffer.from('evidence'));
    writeFileSync(join(root, 'artifacts', hash), 'corrupt');
    expect(() => artifacts.get(hash)).toThrow('ARTIFACT_CORRUPT');
    expect(() => artifacts.put(Buffer.from('evidence'))).toThrow(
      'ARTIFACT_CORRUPT',
    );
    expect(() => artifacts.get('f'.repeat(64))).toThrow();
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, 'linked'), 'junction');
    expect(() => new ArtifactStore(join(root, 'linked'))).toThrow(
      'UNSAFE_PATH',
    );
    expect(() => new ArtifactStore(join(root, 'linked', 'nested'))).toThrow(
      'UNSAFE_PATH',
    );
  });
  it('rejects a store root replaced by a symlink after construction', () => {
    rmSync(join(root, 'artifacts'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, 'artifacts'), 'junction');
    expect(() => artifacts.put(Buffer.from('evidence'))).toThrow('UNSAFE_PATH');
    expect(readdirSync(join(root, 'outside'))).toEqual([]);
  });
});
describe('verified snapshots', () => {
  it('restores a consistent database and verified artifacts to a new destination', async () => {
    store.create('create', task);
    const hash = artifacts.put(Buffer.from('evidence'));
    await backupSnapshot(store, artifacts, join(root, 'backup'));
    store.queue('queue', 'task', 0);
    await restoreSnapshot(join(root, 'backup'), join(root, 'restore'));
    const db = new Database(join(root, 'restore', 'state.sqlite'), {
      readonly: true,
    });
    expect(
      (db.prepare('SELECT body FROM tasks').get() as { body: string }).body,
    ).toContain('"state":"draft"');
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
    expect(
      new ArtifactStore(join(root, 'restore', 'artifacts'))
        .get(hash)
        .toString(),
    ).toBe('evidence');
    expect(
      readFileSync(join(root, 'backup', 'manifest.json'), 'utf8'),
    ).toContain(hash);
  });
  it('rejects corrupt or missing snapshot objects without leaving a restore target', async () => {
    const hash = artifacts.put(Buffer.from('evidence'));
    await backupSnapshot(store, artifacts, join(root, 'backup'));
    const object = join(root, 'backup', 'artifacts', hash);
    writeFileSync(object, 'corrupt');
    await expect(
      restoreSnapshot(join(root, 'backup'), join(root, 'restore')),
    ).rejects.toThrow();
    unlinkSync(object);
    await expect(
      restoreSnapshot(join(root, 'backup'), join(root, 'restore')),
    ).rejects.toThrow();
    expect(readdirSync(root)).not.toContain('restore');
    expect(
      readdirSync(root).filter((name) => name.startsWith('.snapshot-')),
    ).toEqual([]);
  });
  it('rejects corrupt databases and unsupported schemas even with updated manifest hashes', async () => {
    await backupSnapshot(store, artifacts, join(root, 'backup'));
    const dbPath = join(root, 'backup', 'state.sqlite');
    const db = new Database(dbPath);
    db.pragma('user_version=99');
    db.close();
    const manifestPath = join(root, 'backup', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      database: { sha256: string };
    };
    manifest.database.sha256 = createHash('sha256')
      .update(readFileSync(dbPath))
      .digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(
      restoreSnapshot(join(root, 'backup'), join(root, 'restore')),
    ).rejects.toThrow('SCHEMA_UNSUPPORTED');
    writeFileSync(dbPath, 'bad sqlite');
    await expect(
      restoreSnapshot(join(root, 'backup'), join(root, 'restore')),
    ).rejects.toThrow();
  });
  it('never overwrites an existing destination and cleans failed backup output', async () => {
    mkdirSync(join(root, 'occupied'));
    writeFileSync(join(root, 'occupied', 'keep'), 'safe');
    await expect(
      backupSnapshot(store, artifacts, join(root, 'occupied')),
    ).rejects.toThrow('DESTINATION_EXISTS');
    await expect(
      backupSnapshot(
        {
          backup: async (path) => {
            writeFileSync(path, 'partial');
            throw new Error('injected');
          },
        },
        artifacts,
        join(root, 'backup'),
      ),
    ).rejects.toThrow('injected');
    expect(
      readdirSync(root).filter((name) => name.startsWith('.snapshot-')),
    ).toEqual([]);
    expect(readFileSync(join(root, 'occupied', 'keep'), 'utf8')).toBe('safe');
  });
});

function insertReference(hash: string): void {
  store.create('create', task);
  const db = new Database(join(root, 'live.sqlite'));
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS artifacts(hash TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), work_revision INTEGER NOT NULL, PRIMARY KEY(hash,task_id,work_revision))',
    );
    db.prepare('INSERT INTO artifacts VALUES(?,?,?)').run(hash, task.id, 0);
  } finally {
    db.close();
  }
}
describe('snapshot artifact references', () => {
  it('rejects backup if a committed artifact reference has no object', async () => {
    insertReference('a'.repeat(64));
    await expect(
      backupSnapshot(store, artifacts, join(root, 'backup')),
    ).rejects.toThrow('ARTIFACT_MISSING');
    expect(readdirSync(root)).not.toContain('backup');
    expect(
      readdirSync(root).filter((name) => name.startsWith('.snapshot-')),
    ).toEqual([]);
  });
  it('rejects restore when the manifest omits a referenced object', async () => {
    const hash = artifacts.put(Buffer.from('referenced evidence'));
    insertReference(hash);
    await backupSnapshot(store, artifacts, join(root, 'backup'));
    const path = join(root, 'backup', 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      artifacts: string[];
    };
    manifest.artifacts = [];
    writeFileSync(path, JSON.stringify(manifest));
    await expect(
      restoreSnapshot(join(root, 'backup'), join(root, 'restore')),
    ).rejects.toThrow('ARTIFACT_MISSING');
    expect(readdirSync(root)).not.toContain('restore');
  });
  it('preserves both referenced and retained unreferenced artifacts', async () => {
    const hash = artifacts.put(Buffer.from('referenced evidence'));
    const retained = artifacts.put(
      Buffer.from('retained unreferenced evidence'),
    );
    insertReference(hash);
    await backupSnapshot(store, artifacts, join(root, 'backup'));
    await restoreSnapshot(join(root, 'backup'), join(root, 'restore'));
    const restored = new ArtifactStore(join(root, 'restore', 'artifacts'));
    expect(restored.hashes()).toEqual([hash, retained].sort());
    const db = new Database(join(root, 'restore', 'state.sqlite'), {
      readonly: true,
    });
    try {
      expect(db.prepare('SELECT hash FROM artifacts').all()).toEqual([
        { hash },
      ]);
    } finally {
      db.close();
    }
  });
});

it('ignores unfinished object writes but rejects unrelated entries and non-file objects', () => {
  const hash = artifacts.put(Buffer.from('good'));
  const unfinished = '.tmp-00000000-0000-0000-0000-000000000000';
  writeFileSync(join(root, 'artifacts', unfinished), 'partial');
  expect(artifacts.hashes()).toEqual([hash]);
  writeFileSync(join(root, 'artifacts', 'unexpected.txt'), 'bad');
  expect(() => artifacts.hashes()).toThrow('UNEXPECTED_ARTIFACT');
  unlinkSync(join(root, 'artifacts', 'unexpected.txt'));
  mkdirSync(join(root, 'artifacts', 'f'.repeat(64)));
  expect(() => artifacts.get('f'.repeat(64))).toThrow('UNSAFE_PATH');
});
it.each([
  [
    'missing columns',
    'ALTER TABLE artifacts RENAME COLUMN work_revision TO invalid_column',
    'SCHEMA_UNSUPPORTED',
  ],
  [
    'dangling foreign key',
    "PRAGMA foreign_keys=OFF; INSERT INTO artifacts VALUES('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','absent',0)",
    'DATABASE_CORRUPT',
  ],
  [
    'missing outbox primary key',
    'DROP TABLE outbox; CREATE TABLE outbox(operation_id TEXT REFERENCES operations(id), status TEXT NOT NULL)',
    'SCHEMA_UNSUPPORTED',
  ],
  [
    'missing outbox nullability',
    'DROP TABLE outbox; CREATE TABLE outbox(operation_id TEXT PRIMARY KEY REFERENCES operations(id), status TEXT)',
    'SCHEMA_UNSUPPORTED',
  ],
  [
    'wrong outbox foreign key',
    'DROP TABLE outbox; CREATE TABLE outbox(operation_id TEXT PRIMARY KEY REFERENCES tasks(id), status TEXT NOT NULL)',
    'SCHEMA_UNSUPPORTED',
  ],
  [
    'wrong command key order',
    'DROP TABLE commands; CREATE TABLE commands(project_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(kind,project_id,key))',
    'SCHEMA_UNSUPPORTED',
  ],
  [
    'wrong outbox value type',
    'DROP TABLE outbox; CREATE TABLE outbox(operation_id TEXT PRIMARY KEY REFERENCES operations(id), status BLOB NOT NULL)',
    'SCHEMA_UNSUPPORTED',
  ],
  ['invalid hash', "UPDATE artifacts SET hash='../outside'", undefined],
] as const)(
  'rejects snapshot databases with %s',
  async (_label, sql, error) => {
    const hash = artifacts.put(Buffer.from('referenced evidence'));
    insertReference(hash);
    await backupSnapshot(store, artifacts, join(root, 'backup'));
    const databasePath = join(root, 'backup', 'state.sqlite');
    const db = new Database(databasePath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    const manifestPath = join(root, 'backup', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      database: { sha256: string };
    };
    manifest.database.sha256 = createHash('sha256')
      .update(readFileSync(databasePath))
      .digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(
      restoreSnapshot(join(root, 'backup'), join(root, 'restore')),
    ).rejects.toThrow(error);
    expect(readdirSync(root)).not.toContain('restore');
    expect(
      readdirSync(root).filter((name) => name.startsWith('.snapshot-')),
    ).toEqual([]);
  },
);
it('rejects manifest traversal and duplicate objects, symlink sources, and existing restore targets', async () => {
  const hash = artifacts.put(Buffer.from('referenced evidence'));
  insertReference(hash);
  await backupSnapshot(store, artifacts, join(root, 'backup'));
  const manifestPath = join(root, 'backup', 'manifest.json');
  const original = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(original) as {
    database: { file: string };
    artifacts: string[];
  };
  manifest.database.file = '../live.sqlite';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await expect(
    restoreSnapshot(join(root, 'backup'), join(root, 'restore')),
  ).rejects.toThrow();
  manifest.database.file = 'state.sqlite';
  manifest.artifacts = [hash, hash];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await expect(
    restoreSnapshot(join(root, 'backup'), join(root, 'restore')),
  ).rejects.toThrow();
  writeFileSync(manifestPath, original);
  symlinkSync(join(root, 'backup'), join(root, 'alias'), 'junction');
  await expect(
    restoreSnapshot(join(root, 'alias'), join(root, 'restore')),
  ).rejects.toThrow('UNSAFE_PATH');
  mkdirSync(join(root, 'occupied'));
  writeFileSync(join(root, 'occupied', 'keep'), 'safe');
  await expect(
    restoreSnapshot(join(root, 'backup'), join(root, 'occupied')),
  ).rejects.toThrow('DESTINATION_EXISTS');
  expect(readFileSync(join(root, 'occupied', 'keep'), 'utf8')).toBe('safe');
});
