import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { idSchema } from '../../contracts/src/index.ts';
import type { Task } from '../../contracts/src/index.ts';
import {
  memoryProposalSchema,
  memorySearchSchema,
} from '../../contracts/src/memory.ts';
import type {
  MemoryProposal,
  MemoryRecord,
  MemorySearch,
} from '../../contracts/src/memory.ts';

/** Record IDs are unique per project, so another project's IDs are never observable. */
export const memoryMigration = `
CREATE TABLE memory_records(project_id TEXT NOT NULL, id TEXT NOT NULL, namespace TEXT NOT NULL, status TEXT NOT NULL, proposal_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id, id));
CREATE INDEX memory_scope ON memory_records(project_id, status, namespace);
CREATE VIRTUAL TABLE memory_text USING fts5(content);
`;
interface Host {
  transaction<T>(fn: () => T): T;
  now(): number;
  task(id: string): Task;
}
function fail(code: string): never {
  throw new Error(code);
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : child,
  );
}
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');
/** Search words are quoted, so FTS operators in user text stay inert. */
function ftsQuery(text: string): string | undefined {
  const words = [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 32),
    ),
  ];
  return words.length
    ? words.map((word) => '"' + word + '"').join(' OR ')
    : undefined;
}

/**
 * Namespaced project memory. Workers can only propose, bound to their task's
 * current attempt in the same project; acceptance, rejection and supersession
 * are explicit host decisions. All writes run inside the fenced controller
 * transaction.
 */
export class MemoryRecords {
  private readonly db: Database.Database;
  private readonly host: Host;
  constructor(db: Database.Database, host: Host) {
    this.db = db;
    this.host = host;
  }
  private load(projectId: string, id: string): MemoryRecord | undefined {
    const row = this.db
      .prepare('SELECT body FROM memory_records WHERE project_id=? AND id=?')
      .get(projectId, id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as MemoryRecord) : undefined;
  }
  private save(record: MemoryRecord): void {
    this.db
      .prepare(
        'UPDATE memory_records SET status=?, body=? WHERE project_id=? AND id=?',
      )
      .run(record.status, JSON.stringify(record), record.projectId, record.id);
  }
  get(projectId: string, id: string): MemoryRecord {
    const record = this.load(
      idSchema.safeParse(projectId).data ?? fail('INVALID_INPUT'),
      idSchema.safeParse(id).data ?? fail('INVALID_INPUT'),
    );
    return record ?? fail('NOT_FOUND');
  }
  propose(input: MemoryProposal): MemoryRecord {
    const parsed = memoryProposalSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_INPUT');
    const value = parsed.data;
    const proposalHash = sha256(canonical(value));
    return this.host.transaction(() => {
      const { source, taskId, attemptId } = value.provenance;
      if (source === 'worker') {
        const task = this.host.task(taskId!);
        if (task.projectId !== value.projectId) fail('ACCESS_DENIED');
        if (task.attemptId !== attemptId) fail('STALE_ATTEMPT');
      }
      const existing = this.db
        .prepare(
          'SELECT proposal_hash, body FROM memory_records WHERE project_id=? AND id=?',
        )
        .get(value.projectId, value.id) as
        { proposal_hash: string; body: string } | undefined;
      if (existing)
        return existing.proposal_hash === proposalHash
          ? (JSON.parse(existing.body) as MemoryRecord)
          : fail('CONFLICT');
      if (value.supersedes !== undefined) {
        const target =
          this.load(value.projectId, value.supersedes) ?? fail('NOT_FOUND');
        if (
          target.namespace !== value.namespace ||
          target.kind !== value.kind ||
          target.status !== 'accepted'
        )
          fail('INVALID_INPUT');
      }
      const record: MemoryRecord = {
        ...value,
        status: 'proposed',
        contentHash: sha256(value.content),
        createdAt: this.host.now(),
        rowVersion: 0,
      };
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO memory_records VALUES(?,?,?,?,?,?)')
        .run(
          record.projectId,
          record.id,
          record.namespace,
          record.status,
          proposalHash,
          JSON.stringify(record),
        );
      this.db
        .prepare('INSERT INTO memory_text(rowid, content) VALUES(?,?)')
        .run(lastInsertRowid, record.content);
      return record;
    });
  }
  /** Accepting a superseding record retires its target in the same transaction. */
  decide(
    projectId: string,
    id: string,
    input: {
      decision: 'accept' | 'reject';
      actorId: string;
      expectedVersion: number;
    },
  ): MemoryRecord {
    if (
      !idSchema.safeParse(input.actorId).success ||
      !['accept', 'reject'].includes(input.decision) ||
      !Number.isSafeInteger(input.expectedVersion)
    )
      fail('INVALID_INPUT');
    return this.host.transaction(() => {
      const record = this.get(projectId, id);
      if (record.rowVersion !== input.expectedVersion) fail('CONFLICT');
      if (record.status !== 'proposed') fail('ILLEGAL_TRANSITION');
      const now = this.host.now();
      if (input.decision === 'accept' && record.supersedes !== undefined) {
        const target = this.get(projectId, record.supersedes);
        if (target.status !== 'accepted') fail('CONFLICT');
        this.save({
          ...target,
          status: 'superseded',
          supersededBy: record.id,
          rowVersion: target.rowVersion + 1,
        });
      }
      const decided: MemoryRecord = {
        ...record,
        status: input.decision === 'accept' ? 'accepted' : 'rejected',
        decidedAt: now,
        decidedBy: input.actorId,
        rowVersion: record.rowVersion + 1,
      };
      this.save(decided);
      return decided;
    });
  }
  /** Records of one project only. Defaults to accepted records; namespaces match by segment prefix. */
  search(projectId: string, filter: MemorySearch = {}): MemoryRecord[] {
    const parsed = memorySearchSchema.safeParse(filter);
    if (!idSchema.safeParse(projectId).success || !parsed.success)
      fail('INVALID_INPUT');
    const {
      query,
      namespaces = [],
      statuses = ['accepted'],
      limit = 50,
    } = parsed.data;
    const where = [
      'r.project_id = ?',
      'r.status IN (' + statuses.map(() => '?').join(',') + ')',
    ];
    const params: unknown[] = [projectId, ...statuses];
    if (namespaces.length) {
      where.push(
        '(' +
          namespaces
            .map(
              () =>
                "(r.namespace = ? OR substr(r.namespace, 1, length(?) + 1) = ? || '/')",
            )
            .join(' OR ') +
          ')',
      );
      for (const namespace of namespaces)
        params.push(namespace, namespace, namespace);
    }
    let sql: string;
    if (query !== undefined) {
      const match = ftsQuery(query);
      if (!match) return [];
      sql =
        'SELECT r.body FROM memory_text t JOIN memory_records r ON r.rowid = t.rowid WHERE memory_text MATCH ? AND ' +
        where.join(' AND ') +
        ' ORDER BY bm25(memory_text), r.id LIMIT ?';
      params.unshift(match);
    } else
      sql =
        'SELECT r.body FROM memory_records r WHERE ' +
        where.join(' AND ') +
        ' ORDER BY r.id LIMIT ?';
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as { body: string }[]).map(
      (row) => JSON.parse(row.body) as MemoryRecord,
    );
  }
  /** Project access derives from the task record, never from the caller. */
  searchForTask(taskId: string, filter: MemorySearch = {}): MemoryRecord[] {
    return this.search(this.host.task(taskId).projectId, filter);
  }
}
