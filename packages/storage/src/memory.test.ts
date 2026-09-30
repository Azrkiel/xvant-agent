import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from './store.ts';
import { ArtifactStore, backupSnapshot, restoreSnapshot } from './artifacts.ts';
import type { MemoryProposal } from '../../contracts/src/memory.ts';

let root: string;
let now: number;
const stores: Store[] = [];
function open(owner = 'controller') {
  const store = new Store(join(root, 'state.sqlite'), {
    owner,
    now: () => now,
    leaseMs: 1000,
  });
  stores.push(store);
  return store;
}
function task(store: Store, id: string, projectId: string) {
  store.create('create-' + id, {
    id,
    projectId,
    objective: 'Objective ' + id,
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Pass'],
  });
  store.queue('queue-' + id, id, 0);
  store.dispatch('dispatch-' + id, {
    taskId: id,
    workerId: 'worker-' + id,
    attemptId: 'attempt-' + id,
    workspaceId: 'workspace-' + id,
    sessionId: 'session-' + id,
    scenario: 'success',
    expectedVersion: store.getTask(id).rowVersion,
  });
}
function proposal(
  id: string,
  content: string,
  extra: Partial<MemoryProposal> = {},
): MemoryProposal {
  return {
    id,
    projectId: 'project',
    namespace: 'architecture',
    kind: 'fact',
    content,
    confidence: 'reported',
    provenance: { source: 'user', actorId: 'owner' },
    ...extra,
  };
}
let store: Store;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-memory-'));
  now = 1000;
  store = open();
  task(store, 'task', 'project');
  task(store, 'foreign', 'other');
});
afterEach(() => {
  for (const item of stores.splice(0)) item.close();
  rmSync(root, { recursive: true, force: true });
});

describe('memory records', () => {
  it('persists proposals and explicit acceptance across restart', () => {
    const proposed = store.memory.propose(
      proposal('m1', 'The controller owns all SQLite writes'),
    );
    expect(proposed).toMatchObject({
      status: 'proposed',
      rowVersion: 0,
      createdAt: 1000,
      contentHash: createHash('sha256')
        .update('The controller owns all SQLite writes')
        .digest('hex'),
    });
    now = 1500;
    store.memory.decide('project', 'm1', {
      decision: 'accept',
      actorId: 'owner',
      expectedVersion: 0,
    });
    store.close();
    store = open('next');
    expect(store.memory.get('project', 'm1')).toMatchObject({
      status: 'accepted',
      decidedAt: 1500,
      decidedBy: 'owner',
      rowVersion: 1,
    });
    expect(store.schemaVersion()).toBe(3);
  });
  it('treats an identical re-proposal as idempotent and a changed one as a conflict', () => {
    const first = store.memory.propose(proposal('m1', 'Fact'));
    expect(store.memory.propose(proposal('m1', 'Fact'))).toEqual(first);
    expect(() => store.memory.propose(proposal('m1', 'Other fact'))).toThrow(
      'CONFLICT',
    );
  });
  it('binds worker proposals to the current attempt of a task in the same project', () => {
    const worker = {
      source: 'worker' as const,
      actorId: 'codex-1',
      taskId: 'task',
      attemptId: 'attempt-task',
    };
    expect(
      store.memory.propose(
        proposal('w1', 'Tests use vitest', { provenance: worker }),
      ).status,
    ).toBe('proposed');
    expect(() =>
      store.memory.propose(
        proposal('w2', 'x', { provenance: { ...worker, attemptId: 'old' } }),
      ),
    ).toThrow('STALE_ATTEMPT');
    expect(() =>
      store.memory.propose(
        proposal('w3', 'x', {
          provenance: {
            ...worker,
            taskId: 'foreign',
            attemptId: 'attempt-foreign',
          },
        }),
      ),
    ).toThrow('ACCESS_DENIED');
    expect(() =>
      store.memory.propose(
        proposal('w4', 'x', { provenance: { ...worker, taskId: 'missing' } }),
      ),
    ).toThrow('NOT_FOUND');
    expect(() =>
      store.memory.propose(
        proposal('w5', 'x', { confidence: 'verified', provenance: worker }),
      ),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      store.memory.propose(
        proposal('w6', 'x', {
          provenance: { source: 'worker', actorId: 'codex-1' },
        }),
      ),
    ).toThrow('INVALID_INPUT');
  });
  it('allows only proposed records to be decided, at the expected version', () => {
    store.memory.propose(proposal('m1', 'Fact'));
    expect(() =>
      store.memory.decide('project', 'm1', {
        decision: 'accept',
        actorId: 'owner',
        expectedVersion: 7,
      }),
    ).toThrow('CONFLICT');
    store.memory.decide('project', 'm1', {
      decision: 'reject',
      actorId: 'owner',
      expectedVersion: 0,
    });
    expect(store.memory.get('project', 'm1').status).toBe('rejected');
    expect(() =>
      store.memory.decide('project', 'm1', {
        decision: 'accept',
        actorId: 'owner',
        expectedVersion: 1,
      }),
    ).toThrow('ILLEGAL_TRANSITION');
    expect(() =>
      store.memory.decide('project', 'missing', {
        decision: 'accept',
        actorId: 'owner',
        expectedVersion: 0,
      }),
    ).toThrow('NOT_FOUND');
  });
  it('supersedes atomically and refuses a second replacement of the same record', () => {
    const accept = (id: string, version = 0) =>
      store.memory.decide('project', id, {
        decision: 'accept',
        actorId: 'owner',
        expectedVersion: version,
      });
    store.memory.propose(proposal('a', 'Use REST'));
    accept('a');
    store.memory.propose(
      proposal('b', 'Use SSE for events', { supersedes: 'a' }),
    );
    store.memory.propose(proposal('c', 'Use websockets', { supersedes: 'a' }));
    accept('b');
    expect(store.memory.get('project', 'a')).toMatchObject({
      status: 'superseded',
      supersededBy: 'b',
    });
    expect(store.memory.get('project', 'b').status).toBe('accepted');
    expect(() => accept('c')).toThrow('CONFLICT');
    expect(store.memory.get('project', 'c').status).toBe('proposed');
  });
  it.each([
    ['a missing record', { supersedes: 'missing' }],
    ['another namespace', { supersedes: 'a', namespace: 'testing' }],
    ['another kind', { supersedes: 'a', kind: 'convention' as const }],
    ['a record that is not accepted', { supersedes: 'p' }],
  ])('refuses to supersede %s', (_name, extra) => {
    store.memory.propose(proposal('a', 'Accepted'));
    store.memory.decide('project', 'a', {
      decision: 'accept',
      actorId: 'owner',
      expectedVersion: 0,
    });
    store.memory.propose(proposal('p', 'Still proposed'));
    expect(() => store.memory.propose(proposal('n', 'New', extra))).toThrow(
      /INVALID_INPUT|NOT_FOUND/,
    );
  });
  it('searches within one project, accepted records, and namespace prefixes', () => {
    const accepted = (value: MemoryProposal) => {
      store.memory.propose(value);
      store.memory.decide(value.projectId, value.id, {
        decision: 'accept',
        actorId: 'owner',
        expectedVersion: 0,
      });
    };
    accepted(
      proposal('db', 'SQLite WAL mode is required', {
        namespace: 'architecture/storage',
      }),
    );
    accepted(proposal('api', 'The API uses SSE for events'));
    accepted(
      proposal('arch2', 'SQLite lives outside sync folders', {
        namespace: 'architecture2',
      }),
    );
    accepted(
      proposal('x', 'SQLite secret from another project', {
        projectId: 'other',
      }),
    );
    store.memory.propose(proposal('draft', 'SQLite draft note'));
    expect(
      store.memory
        .search('project', { query: 'sqlite' })
        .map((record) => record.id),
    ).toEqual(['arch2', 'db']);
    expect(
      store.memory
        .search('project', { namespaces: ['architecture'] })
        .map((record) => record.id),
    ).toEqual(['api', 'db']);
    expect(
      store.memory
        .search('project', { statuses: ['proposed'] })
        .map((record) => record.id),
    ).toEqual(['draft']);
    expect(
      store.memory.searchForTask('task', { query: 'secret another project' }),
    ).toEqual([]);
    expect(
      store.memory.searchForTask('foreign', {}).map((record) => record.id),
    ).toEqual(['x']);
    expect(() => store.memory.get('other', 'db')).toThrow('NOT_FOUND');
    expect(() => store.memory.search('project', { query: '"' })).not.toThrow();
  });
  it('fences writes after another controller takes ownership', () => {
    now += 5000;
    open('successor');
    expect(() => store.memory.propose(proposal('late', 'Late write'))).toThrow(
      'STALE_FENCE',
    );
  });
  it('keeps memory searchable through a verified snapshot and rejects a swapped index', async () => {
    store.memory.propose(
      proposal('m1', 'Snapshots restore into new directories'),
    );
    store.memory.decide('project', 'm1', {
      decision: 'accept',
      actorId: 'owner',
      expectedVersion: 0,
    });
    const objects = new ArtifactStore(join(root, 'objects'));
    await backupSnapshot(store, objects, join(root, 'backup'));
    await restoreSnapshot(join(root, 'backup'), join(root, 'restored'));
    const restored = new Store(join(root, 'restored', 'state.sqlite'), {
      owner: 'restored',
      // Snapshots keep the controller lease; open after it lapses.
      now: () => now + 5000,
    });
    stores.push(restored);
    expect(
      restored.memory
        .search('project', { query: 'snapshots' })
        .map((r) => r.id),
    ).toEqual(['m1']);
    const dbPath = join(root, 'backup', 'state.sqlite');
    const db = new Database(dbPath);
    db.exec(
      'DROP TABLE memory_text; CREATE VIRTUAL TABLE memory_text USING fts5(content, extra)',
    );
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
      restoreSnapshot(join(root, 'backup'), join(root, 'second')),
    ).rejects.toThrow('SCHEMA_UNSUPPORTED');
  });
});
