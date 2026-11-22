import type Database from 'better-sqlite3';

export const scheduleMigration = `
CREATE TABLE schedule_jobs (
  id TEXT PRIMARY KEY REFERENCES work_graphs(id),
  project TEXT NOT NULL,
  priority INTEGER NOT NULL,
  dueAt INTEGER NOT NULL,
  retryAt INTEGER,
  acceptedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  slots INTEGER NOT NULL,
  resources TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  generation INTEGER,
  claim INTEGER,
  cancelRequested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX schedule_runnable ON schedule_jobs(status, dueAt, retryAt);
CREATE TABLE schedule_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  intake INTEGER NOT NULL,
  dispatch INTEGER NOT NULL,
  draining INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  clock TEXT
);
INSERT INTO schedule_control VALUES(1,1,1,0,0,NULL);
CREATE TABLE schedule_projects (id TEXT PRIMARY KEY, served INTEGER NOT NULL);
ALTER TABLE ownership ADD COLUMN boot TEXT;
ALTER TABLE ownership ADD COLUMN uptimeExpiry INTEGER;
`;

export type JobStatus = 'queued' | 'running' | 'blocked' | 'done' | 'cancelled';
export interface Job {
  id: string;
  project: string;
  priority: number;
  dueAt: number;
  retryAt: number | null;
  acceptedAt: number;
  updatedAt: number;
  slots: number;
  resources: string[];
  status: JobStatus;
  reason: string | null;
  generation: number | null;
  claim: number | null;
  cancelRequested: number;
}

export type Lifecycle =
  'pause-intake' | 'pause-dispatch' | 'drain' | 'continue';
export interface ClockSample {
  boot: string;
  uptime: number;
  time: number;
}

interface Host {
  transaction: <T>(run: () => T) => T;
  generation: () => number;
  now: () => number;
}
type JobRow = Omit<Job, 'resources'> & { resources: string };
type NewJob = Pick<
  Job,
  'id' | 'project' | 'priority' | 'dueAt' | 'slots' | 'resources'
>;
type Wait = { reason: string; retryAt?: number };

export class Schedule {
  constructor(db: Database.Database, host: Host) {
    this.#db = db;
    this.#host = host;
  }

  readonly #db: Database.Database;
  readonly #host: Host;

  control(): {
    intake: number;
    dispatch: number;
    draining: number;
    sequence: number;
  } {
    return this.#db
      .prepare(
        'SELECT intake, dispatch, draining, sequence FROM schedule_control',
      )
      .get() as ReturnType<Schedule['control']>;
  }

  setControl(action: Lifecycle) {
    return this.#host.transaction(() => {
      const current = this.control();
      const intake =
        action === 'continue'
          ? 1
          : action === 'pause-dispatch'
            ? current.intake
            : 0;
      const dispatch =
        action === 'continue'
          ? 1
          : action === 'pause-intake'
            ? current.dispatch
            : 0;
      const draining =
        action === 'drain' || (action === 'pause-intake' && current.draining)
          ? 1
          : 0;
      this.#db
        .prepare('UPDATE schedule_control SET intake=?, dispatch=?, draining=?')
        .run(intake, dispatch, draining);
      return this.control();
    });
  }

  clock(): ClockSample | null {
    const { clock } = this.#db
      .prepare('SELECT clock FROM schedule_control')
      .get() as { clock: string | null };
    return clock === null ? null : (JSON.parse(clock) as ClockSample);
  }

  saveClock(sample: ClockSample) {
    this.#db
      .prepare('UPDATE schedule_control SET clock=?')
      .run(JSON.stringify(sample));
  }

  get(id: string): Job | undefined {
    const row = this.#db
      .prepare('SELECT * FROM schedule_jobs WHERE id=?')
      .get(id) as JobRow | undefined;
    return row && this.#decode(row);
  }

  pending(): Job[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM schedule_jobs WHERE status IN ('queued','running','blocked') ORDER BY rowid",
      )
      .all() as JobRow[];
    return rows.map((row) => this.#decode(row));
  }

  #decode(row: JobRow): Job {
    return { ...row, resources: JSON.parse(row.resources) as string[] };
  }

  add(job: NewJob): Job {
    return this.#host.transaction(() => {
      const now = this.#host.now();
      this.#db
        .prepare(
          `
        INSERT INTO schedule_jobs(id,project,priority,dueAt,acceptedAt,updatedAt,slots,resources,status)
        VALUES(?,?,?,?,?,?,?,?,'queued')
      `,
        )
        .run(
          job.id,
          job.project,
          job.priority,
          job.dueAt,
          now,
          now,
          job.slots,
          JSON.stringify(job.resources),
        );
      return this.get(job.id)!;
    });
  }

  requeue(id: string, retryAt?: number): void {
    this.#host.transaction(() => {
      this.#db
        .prepare(
          `
        UPDATE schedule_jobs SET status='queued', retryAt=?, reason=NULL, updatedAt=?
        WHERE id=? AND status='blocked'
      `,
        )
        .run(retryAt ?? null, this.#host.now(), id);
    });
  }

  progressing(id: string): void {
    this.#host.transaction(() => {
      this.#db
        .prepare(
          "UPDATE schedule_jobs SET updatedAt=? WHERE id=? AND status='running'",
        )
        .run(this.#host.now(), id);
    });
  }

  requestCancel(id: string): void {
    this.#host.transaction(() => {
      this.#db
        .prepare(
          `
        UPDATE schedule_jobs SET cancelRequested=1, updatedAt=?
        WHERE id=? AND status IN ('queued','running','blocked') AND cancelRequested=0
      `,
        )
        .run(this.#host.now(), id);
    });
  }

  /** Release obsolete scheduler claims. Workflow effect reservations are separate. */
  takeover(): void {
    this.#host.transaction(() => {
      this.#db
        .prepare(
          `
        UPDATE schedule_jobs SET status='queued', reason=NULL, retryAt=NULL, updatedAt=?
        WHERE status='running' AND generation<>?
      `,
        )
        .run(this.#host.now(), this.#host.generation());
    });
  }

  settle(
    id: string,
    status: 'blocked' | 'done' | 'cancelled',
    reason: string | null,
    claim?: number,
  ): void {
    this.#host.transaction(() => {
      const result = this.#db
        .prepare(
          `
        UPDATE schedule_jobs SET status=?, reason=?, retryAt=NULL, updatedAt=?
        WHERE id=? AND ((? IS NULL AND status IN ('queued','blocked')) OR
          (status='running' AND claim=? AND generation=?))
      `,
        )
        .run(
          status,
          reason,
          this.#host.now(),
          id,
          claim ?? null,
          claim ?? null,
          this.#host.generation(),
        );
      if (result.changes !== 1) throw new Error('STALE_FENCE');
    });
  }

  /** Within each project use priority then submission order. Among eligible
   * projects prefer the least recently served, even over a higher priority. */
  claim(
    maxSlots: number,
    wait: (job: Job, freeSlots: number) => Wait | undefined,
  ): Job | undefined {
    return this.#host.transaction(() => {
      const { dispatch, sequence } = this.control();
      if (!dispatch) return undefined;
      const now = this.#host.now();
      const running = this.#db
        .prepare("SELECT * FROM schedule_jobs WHERE status='running'")
        .all() as JobRow[];
      const used = running.reduce((total, job) => total + job.slots, 0);
      const reserved = new Set(
        running.flatMap((row) => this.#decode(row).resources),
      );
      const due = this.#db
        .prepare(
          `
        SELECT j.* FROM schedule_jobs j LEFT JOIN schedule_projects p ON p.id=j.project
        WHERE j.status='queued' AND j.dueAt<=? AND (j.retryAt IS NULL OR j.retryAt<=?)
        ORDER BY COALESCE(p.served,0), j.priority DESC, j.rowid
      `,
        )
        .all(now, now) as JobRow[];
      for (const row of due) {
        const job = this.#decode(row);
        const delay: Wait | undefined =
          job.slots + used > maxSlots
            ? { reason: 'WORKER_LIMIT' }
            : job.resources.some((resource) => reserved.has(resource))
              ? { reason: 'RESOURCE_IN_USE' }
              : wait(job, maxSlots - used);
        if (delay) {
          const retryAt = delay.retryAt ?? null;
          if (job.reason !== delay.reason || job.retryAt !== retryAt)
            this.#db
              .prepare(
                'UPDATE schedule_jobs SET reason=?, retryAt=? WHERE id=?',
              )
              .run(delay.reason, retryAt, job.id);
          continue;
        }
        const claim = sequence + 1;
        this.#db.prepare('UPDATE schedule_control SET sequence=?').run(claim);
        this.#db
          .prepare(
            'INSERT INTO schedule_projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET served=excluded.served',
          )
          .run(job.project, claim);
        this.#db
          .prepare(
            `
          UPDATE schedule_jobs SET status='running', claim=?, generation=?, reason=NULL, retryAt=NULL, updatedAt=?
          WHERE id=?
        `,
          )
          .run(claim, this.#host.generation(), now, job.id);
        return this.get(job.id);
      }
      return undefined;
    });
  }

  wakeAt(now: number): number | null {
    const row = this.#db
      .prepare(
        `
      SELECT MIN(MAX(dueAt,COALESCE(retryAt,dueAt))) AS wake
      FROM schedule_jobs WHERE status='queued' AND MAX(dueAt,COALESCE(retryAt,dueAt))>?
    `,
      )
      .get(now) as { wake: number | null };
    return row.wake;
  }
}
