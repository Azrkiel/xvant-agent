import type Database from 'better-sqlite3';
import { z } from 'zod';
import { idSchema } from '../../contracts/src/index.ts';

export const workflowMigration = `
CREATE TABLE work_checkpoints(graph_id TEXT PRIMARY KEY REFERENCES work_graphs(id), body TEXT NOT NULL);
CREATE TABLE work_actions(graph_id TEXT NOT NULL REFERENCES work_graphs(id), slot TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(graph_id,slot));
`;
const slotSchema = z.string().min(1).max(256);
const fields = {
  slot: slotSchema,
  kind: z.enum(['initialize', 'turn', 'check', 'apply']),
  generation: z.number().int().positive(),
  input: z.json(),
};
const actionSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...fields, status: z.literal('prepared') }),
  z.strictObject({ ...fields, status: z.literal('dispatching') }),
  z.strictObject({
    ...fields,
    status: z.literal('completed'),
    result: z.json(),
  }),
]);
export type WorkAction = z.infer<typeof actionSchema>;

interface Host {
  transaction: <T>(fn: () => T) => T;
  generation: () => number;
  fault: (point: string) => void;
}

/** The graph, checkpoint and action intents share one fenced SQLite transaction. */
export class Workflows {
  readonly #db: Database.Database;
  readonly #host: Host;
  readonly atomic: Host['transaction'];

  constructor(db: Database.Database, host: Host) {
    this.#db = db;
    this.#host = host;
    this.atomic = host.transaction;
  }

  boundary(point: string, slot: string): void {
    this.#host.fault('workflow.' + point + ':' + slot);
  }

  read(id: string): unknown {
    const row = this.#db
      .prepare('SELECT body FROM work_checkpoints WHERE graph_id=?')
      .get(idSchema.parse(id)) as { body: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.body) as unknown;
    } catch {
      throw new Error('CHECKPOINT_INVALID');
    }
  }

  write(id: string, value: unknown): void {
    this.atomic(() => {
      this.#db
        .prepare(
          'INSERT INTO work_checkpoints VALUES(?,?) ON CONFLICT(graph_id) DO UPDATE SET body=excluded.body',
        )
        .run(idSchema.parse(id), JSON.stringify(value));
    });
  }

  action(id: string, slot: string): WorkAction | null {
    const row = this.#db
      .prepare('SELECT slot,body FROM work_actions WHERE graph_id=? AND slot=?')
      .get(idSchema.parse(id), slotSchema.parse(slot)) as
      { slot: string; body: string } | undefined;
    return row ? this.#decode(row) : null;
  }

  actions(id: string): WorkAction[] {
    const rows = this.#db
      .prepare(
        'SELECT slot,body FROM work_actions WHERE graph_id=? ORDER BY rowid',
      )
      .all(idSchema.parse(id)) as { slot: string; body: string }[];
    return rows.map((row) => this.#decode(row));
  }

  #decode(row: { slot: string; body: string }): WorkAction {
    try {
      const action = actionSchema.parse(JSON.parse(row.body));
      if (action.slot !== row.slot) throw new Error('ACTION_SLOT_MISMATCH');
      return action;
    } catch {
      throw new Error('WORKFLOW_ACTION_INVALID');
    }
  }

  prepare(
    id: string,
    slot: string,
    kind: WorkAction['kind'],
    input: unknown,
  ): WorkAction {
    return this.atomic(() => {
      const action = actionSchema.parse({
        slot,
        kind,
        input,
        status: 'prepared',
        generation: this.#host.generation(),
      });
      if (
        !this.#db
          .prepare('INSERT OR IGNORE INTO work_actions VALUES(?,?,?)')
          .run(idSchema.parse(id), action.slot, JSON.stringify(action)).changes
      )
        throw new Error('CONFLICT');
      this.boundary('intent.before_commit', slot);
      return action;
    });
  }

  claim(
    id: string,
    slot: string,
  ): Extract<WorkAction, { status: 'dispatching' }> {
    return this.atomic(() => {
      const action = this.action(id, slot);
      if (!action || action.status !== 'prepared')
        throw new Error('UNRESOLVED_WORKFLOW_ACTION');
      const next = {
        ...action,
        status: 'dispatching' as const,
        generation: this.#host.generation(),
      };
      this.#replace(id, next);
      return next;
    });
  }

  complete(id: string, slot: string, generation: number, value: unknown): void {
    this.atomic(() => {
      const action = this.action(id, slot);
      if (
        !action ||
        generation !== this.#host.generation() ||
        action.generation !== generation
      )
        throw new Error('STALE_FENCE');
      const next = actionSchema.parse({
        ...action,
        status: 'completed',
        result: value,
      });
      if (action.status === 'completed') {
        if (JSON.stringify(action) !== JSON.stringify(next))
          throw new Error('CONFLICT');
        return;
      }
      if (action.status !== 'dispatching') throw new Error('CONFLICT');
      this.#replace(id, next);
    });
  }

  #replace(id: string, action: WorkAction): void {
    this.#db
      .prepare('UPDATE work_actions SET body=? WHERE graph_id=? AND slot=?')
      .run(JSON.stringify(action), id, action.slot);
  }
}
