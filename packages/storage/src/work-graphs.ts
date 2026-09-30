import type Database from 'better-sqlite3';
import { z } from 'zod';
import { idSchema } from '../../contracts/src/index.ts';

export const workGraphMigration = `
CREATE TABLE work_graphs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE work_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, graph_id TEXT NOT NULL REFERENCES work_graphs(id), kind TEXT NOT NULL, payload TEXT NOT NULL);
`;
export interface WorkGraphRecord<T> {
  id: string;
  projectId: string;
  rowVersion: number;
  state: T;
}
export interface WorkEvent {
  sequence: number;
  graphId: string;
  kind: string;
  payload: unknown;
}
interface Host {
  transaction: <T>(fn: () => T) => T;
}
function fail(code: string): never {
  throw new Error(code);
}
const kindSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);

/**
 * Durable orchestration state: one JSON document per root task with an
 * optimistic row version, and an append-only event history that explains
 * every transition. Writes go through the Store's fenced transactions, so a
 * controller that lost its lease cannot advance a graph.
 */
export class WorkGraphs {
  readonly #db: Database.Database;
  readonly #host: Host;
  constructor(db: Database.Database, host: Host) {
    this.#db = db;
    this.#host = host;
  }
  create<T>(
    id: string,
    projectId: string,
    state: T,
    event: unknown,
  ): WorkGraphRecord<T> {
    idSchema.parse(id);
    idSchema.parse(projectId);
    return this.#host.transaction(() => {
      if (this.#db.prepare('SELECT id FROM work_graphs WHERE id=?').get(id))
        fail('DUPLICATE_IDENTITY');
      const record = { id, projectId, rowVersion: 1, state };
      this.#db
        .prepare('INSERT INTO work_graphs VALUES(?,?,?)')
        .run(id, projectId, JSON.stringify(record));
      this.#append(id, 'graph.created', event);
      return structuredClone(record);
    });
  }
  get<T>(id: string): WorkGraphRecord<T> {
    const row = this.#db
      .prepare('SELECT body FROM work_graphs WHERE id=?')
      .get(idSchema.parse(id)) as { body: string } | undefined;
    if (!row) fail('NOT_FOUND');
    return JSON.parse(row.body) as WorkGraphRecord<T>;
  }
  list(
    projectId?: string,
  ): { id: string; projectId: string; rowVersion: number }[] {
    const rows = (
      projectId === undefined
        ? this.#db.prepare('SELECT body FROM work_graphs ORDER BY rowid').all()
        : this.#db
            .prepare(
              'SELECT body FROM work_graphs WHERE project_id=? ORDER BY rowid',
            )
            .all(idSchema.parse(projectId))
    ) as { body: string }[];
    return rows.map((row) => {
      const record = JSON.parse(row.body) as WorkGraphRecord<unknown>;
      return {
        id: record.id,
        projectId: record.projectId,
        rowVersion: record.rowVersion,
      };
    });
  }
  /** Replace the state if the caller saw the current version; record why. */
  update<T>(
    id: string,
    expectedVersion: number,
    state: T,
    kind: string,
    payload: unknown,
  ): WorkGraphRecord<T> {
    kindSchema.parse(kind);
    return this.#host.transaction(() => {
      const current = this.get<T>(id);
      if (current.rowVersion !== expectedVersion) fail('CONFLICT');
      const next = { ...current, rowVersion: current.rowVersion + 1, state };
      this.#db
        .prepare('UPDATE work_graphs SET body=? WHERE id=?')
        .run(JSON.stringify(next), id);
      this.#append(id, kind, payload);
      return structuredClone(next);
    });
  }
  events(id: string, after = 0): WorkEvent[] {
    return (
      this.#db
        .prepare(
          'SELECT sequence,graph_id,kind,payload FROM work_events WHERE graph_id=? AND sequence>? ORDER BY sequence',
        )
        .all(idSchema.parse(id), after) as {
        sequence: number;
        graph_id: string;
        kind: string;
        payload: string;
      }[]
    ).map((row) => ({
      sequence: row.sequence,
      graphId: row.graph_id,
      kind: row.kind,
      payload: JSON.parse(row.payload),
    }));
  }
  #append(id: string, kind: string, payload: unknown): void {
    this.#db
      .prepare('INSERT INTO work_events(graph_id,kind,payload) VALUES(?,?,?)')
      .run(id, kindSchema.parse(kind), JSON.stringify(payload ?? null));
  }
}
