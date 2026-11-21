import type Database from 'better-sqlite3';
import { idSchema } from '../../contracts/src/index.ts';

export const workflowMigration = `
CREATE TABLE work_checkpoints(graph_id TEXT PRIMARY KEY REFERENCES work_graphs(id), body TEXT NOT NULL);
`;

/** Checkpoints share the controller fence and transaction with the root graph. */
export class Workflows {
  readonly #db: Database.Database;
  readonly atomic: <T>(fn: () => T) => T;

  constructor(db: Database.Database, transaction: <T>(fn: () => T) => T) {
    this.#db = db;
    this.atomic = transaction;
  }

  read(id: string): unknown {
    const row = this.#db
      .prepare('SELECT body FROM work_checkpoints WHERE graph_id=?')
      .get(idSchema.parse(id)) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as unknown) : null;
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
}
