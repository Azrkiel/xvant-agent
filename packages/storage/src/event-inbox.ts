import type Database from 'better-sqlite3';

export const eventInboxMigration = `
CREATE TABLE github_issue_deliveries (
  repository_id INTEGER NOT NULL,
  delivery_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  disposition TEXT NOT NULL,
  PRIMARY KEY(repository_id, delivery_id)
);
CREATE INDEX github_issue_revision ON github_issue_deliveries(repository_id, issue_number, revision DESC);
`;

type Observation = {
  repositoryId: number;
  deliveryId: string;
  issueNumber: number;
  revision: number;
  fingerprint: string;
  bodyHash: string;
};

type Receipt = {
  issueNumber: number;
  revision: number;
  receivedAt: number;
  disposition:
    'pending' | 'superseded' | 'duplicate_revision' | 'needs_refresh';
};

interface Host {
  transaction<T>(run: () => T): T;
  now(): number;
}

export class EventInbox {
  readonly #db: Database.Database;
  readonly #host: Host;

  constructor(db: Database.Database, host: Host) {
    this.#db = db;
    this.#host = host;
  }

  /** Current issue revision, with ambiguous same-second edits held for a fresh read. */
  current(repositoryId: number, issueNumber: number) {
    const current = this.#db
      .prepare(
        `SELECT revision, MAX(disposition='needs_refresh') AS ambiguous
       FROM github_issue_deliveries WHERE repository_id=? AND issue_number=?
       GROUP BY revision ORDER BY revision DESC LIMIT 1`,
      )
      .get(repositoryId, issueNumber) as
      { revision: number; ambiguous: number } | undefined;
    return (
      current && {
        repositoryId,
        issueNumber,
        revision: current.revision,
        disposition: current.ambiguous ? 'needs_refresh' : 'pending',
      }
    );
  }

  /** Only authenticated, normalized observations may cross this boundary. */
  receive(event: Observation): Receipt {
    return this.#host.transaction(() => {
      const previous = this.#db
        .prepare(
          `SELECT issue_number AS issueNumber, revision, received_at AS receivedAt,
                disposition, body_hash AS bodyHash
         FROM github_issue_deliveries WHERE repository_id=? AND delivery_id=?`,
        )
        .get(event.repositoryId, event.deliveryId) as
        (Receipt & { bodyHash: string }) | undefined;
      if (previous) {
        const { bodyHash, ...receipt } = previous;
        if (bodyHash !== event.bodyHash) throw new Error('CONFLICT');
        return receipt;
      }
      const newest = this.#db
        .prepare(
          `SELECT revision, fingerprint FROM github_issue_deliveries
         WHERE repository_id=? AND issue_number=? ORDER BY revision DESC, rowid ASC LIMIT 1`,
        )
        .get(event.repositoryId, event.issueNumber) as
        { revision: number; fingerprint: string } | undefined;
      let disposition: Receipt['disposition'] = 'pending';
      if (newest && newest.revision > event.revision)
        disposition = 'superseded';
      if (newest?.revision === event.revision) {
        disposition =
          newest.fingerprint === event.fingerprint
            ? 'duplicate_revision'
            : 'needs_refresh';
      }
      const receivedAt = this.#host.now();
      this.#db
        .prepare('INSERT INTO github_issue_deliveries VALUES(?,?,?,?,?,?,?,?)')
        .run(
          event.repositoryId,
          event.deliveryId,
          event.issueNumber,
          event.revision,
          event.fingerprint,
          event.bodyHash,
          receivedAt,
          disposition,
        );
      return {
        issueNumber: event.issueNumber,
        revision: event.revision,
        receivedAt,
        disposition,
      };
    });
  }
}
