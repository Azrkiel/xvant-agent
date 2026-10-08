import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  idSchema,
  eventSchema,
  parse,
  taskSchema,
  runRequestSchema,
} from '../../contracts/src/index.ts';
import type {
  Task,
  CreateTask,
  Evidence,
  RuntimeEvent,
} from '../../contracts/src/index.ts';
import type { ArtifactStore } from './artifacts.ts';
import { createTask, transitionTask } from '../../core/src/task.ts';
import { ProviderJournal, providerMigration } from './providers.ts';
import { MemoryRecords, memoryMigration } from './memory.ts';
import { WorkGraphs, workGraphMigration } from './work-graphs.ts';
import {
  nativeAcceptanceSchema,
  nativeEvidenceSchema,
} from '../../contracts/src/native-evidence.ts';
import { nativeAcceptanceTask } from '../../core/src/native-acceptance.ts';
import { verifiedWorkspaceObjects } from './workspace.ts';

export class StorageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'StorageError';
  }
}
export type Reason =
  | 'quota'
  | 'worker_failed'
  | 'invalid_event'
  | 'unknown'
  | 'verifier_failed'
  | 'cancelled';
export interface Dispatch {
  taskId: string;
  workerId: string;
  attemptId: string;
  workspaceId: string;
  sessionId: string;
  scenario:
    'success' | 'failure' | 'delayed' | 'malformed' | 'quota' | 'unknown';
  expectedVersion: number;
}
export interface Operation extends Dispatch {
  token: string;
  generation: number;
  status:
    | 'prepared'
    | 'sending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'unknown'
    | 'cancelled';
  sequence: number;
  reason: Reason | null;
}
export interface JournalEvent {
  sequence: number;
  taskId: string;
  kind: string;
  payload: unknown;
}
interface Options {
  owner: string;
  now?: () => number;
  leaseMs?: number;
  fault?: (point: string) => void;
  migrations?: { version: number; sql: string }[];
}
const migration = `
CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE commands(project_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(project_id,kind,key));
CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE operations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL);
CREATE TABLE outbox(operation_id TEXT PRIMARY KEY REFERENCES operations(id), status TEXT NOT NULL);
CREATE TABLE ownership(resource TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE reservations(resource TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id));
CREATE TABLE evidence(task_id TEXT PRIMARY KEY REFERENCES tasks(id), body TEXT NOT NULL);
CREATE TABLE artifacts(hash TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), work_revision INTEGER NOT NULL, PRIMARY KEY(hash,task_id,work_revision));
`;
const json = (value: unknown): string => JSON.stringify(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => json(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return json(value);
}
/** The newest schema this code writes; a database beyond it is refused. */
export const SCHEMA_VERSION = 4;

export class Store {
  readonly providers: ProviderJournal;
  readonly memory: MemoryRecords;
  readonly graphs: WorkGraphs;
  readonly #db: Database.Database;
  readonly #owner: string;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #fault: (point: string) => void;
  #generation = 0;
  #closed = false;
  constructor(path: string, options: Options) {
    this.#owner = parse(idSchema, options.owner);
    this.#now = options.now ?? Date.now;
    this.#ttl = options.leaseMs ?? 30000;
    this.#fault = options.fault ?? (() => {});
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 100)
      throw new StorageError('INVALID_INPUT');
    this.#db = new Database(path, { timeout: 1000 });
    try {
      this.#db.pragma('foreign_keys=ON');
      this.#db.pragma('journal_mode=WAL');
      this.#db.pragma('synchronous=FULL');
      const migrations = [
        { version: 1, sql: migration },
        { version: 2, sql: providerMigration },
        { version: 3, sql: memoryMigration },
        { version: 4, sql: workGraphMigration },
        ...(options.migrations ?? []),
      ];
      if (this.schemaVersion() > migrations.at(-1)!.version)
        throw new StorageError('SCHEMA_UNSUPPORTED');
      this.#db
        .transaction(() => {
          const hasOwnership = this.#db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='ownership'",
            )
            .get();
          const old = hasOwnership
            ? (this.#db
                .prepare("SELECT * FROM ownership WHERE resource='controller'")
                .get() as
                | { owner: string; generation: number; expires: number }
                | undefined)
            : undefined;
          if (old && old.expires > this.#now())
            throw new StorageError('LEASE_BUSY');
          for (const item of migrations)
            if (item.version > this.schemaVersion()) {
              if (item.version !== this.schemaVersion() + 1)
                throw new StorageError('MIGRATION_ORDER');
              this.#db.exec(item.sql);
              this.#db.pragma('user_version=' + item.version);
            }
          this.#generation = (old?.generation ?? 0) + 1;
          this.#db
            .prepare(
              "INSERT INTO ownership VALUES('controller',?,?,?) ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires=excluded.expires",
            )
            .run(this.#owner, this.#generation, this.#now() + this.#ttl);
        })
        .immediate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.graphs = new WorkGraphs(this.#db, {
      transaction: (fn) => this.#transaction(fn),
    });
    this.memory = new MemoryRecords(this.#db, {
      transaction: (fn) => this.#transaction(fn),
      now: () => this.#now(),
      task: (id) => this.getTask(id),
    });
    this.providers = new ProviderJournal(this.#db, {
      transaction: (fn) => this.#transaction(fn),
      generation: this.#generation,
      fault: this.#fault,
      task: (id) => this.getTask(id),
      start: (spec) => {
        const task = this.getTask(spec.taskId);
        this.#version(task, spec.expectedVersion);
        this.#task(
          transitionTask({ ...task, attemptId: spec.attemptId }, 'running'),
        );
        this.#event(task.id, 'provider.reserved', {
          connectionId: spec.connectionId,
          attemptId: spec.attemptId,
        });
        return task.workRevision;
      },
      event: (taskId, kind, payload) => this.#event(taskId, kind, payload),
      attention: (id) => {
        const task = this.getTask(id);
        if (task.state !== 'needs_attention') {
          this.#task(transitionTask(task, 'needs_attention'));
          this.#event(id, 'provider.needs_attention', {
            attemptId: task.attemptId,
          });
        }
      },
    });
  }
  #owned(): void {
    const row = this.#db
      .prepare(
        "SELECT owner,generation,expires FROM ownership WHERE resource='controller'",
      )
      .get() as { owner: string; generation: number; expires: number };
    if (row.owner !== this.#owner || row.generation !== this.#generation)
      throw new StorageError('STALE_FENCE');
    // Expired but not taken over: this process stalled past its lease and is
    // still the only writer, since a takeover would have changed the
    // generation. It resumes instead of failing every later write.
    if (
      row.expires <= this.#now() &&
      this.#db
        .prepare(
          "UPDATE ownership SET expires=? WHERE resource='controller' AND owner=? AND generation=?",
        )
        .run(this.#now() + this.#ttl, this.#owner, this.#generation).changes !==
        1
    )
      throw new StorageError('STALE_FENCE');
  }
  #transaction<T>(fn: () => T): T {
    return this.#db
      .transaction(() => {
        this.#owned();
        return fn();
      })
      .immediate();
  }
  get heartbeatIntervalMs(): number {
    return Math.max(25, Math.floor(this.#ttl / 3));
  }
  heartbeat(): void {
    this.#transaction(() => {
      this.#db
        .prepare("UPDATE ownership SET expires=? WHERE resource='controller'")
        .run(this.#now() + this.#ttl);
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#db
      .prepare(
        "UPDATE ownership SET expires=0 WHERE resource='controller' AND owner=? AND generation=?",
      )
      .run(this.#owner, this.#generation);
    this.#db.close();
    this.#closed = true;
  }
  schemaVersion(): number {
    return this.#db.pragma('user_version', { simple: true }) as number;
  }
  integrity(): string {
    return this.#db.pragma('integrity_check', { simple: true }) as string;
  }
  getTask(id: string): Task {
    const row = this.#db
      .prepare('SELECT body FROM tasks WHERE id=?')
      .get(parse(idSchema, id)) as { body: string } | undefined;
    if (!row) throw new StorageError('NOT_FOUND');
    return parse(taskSchema, JSON.parse(row.body));
  }
  getOperation(id: string): Operation {
    const row = this.#db
      .prepare('SELECT body FROM operations WHERE id=?')
      .get(parse(idSchema, id)) as { body: string } | undefined;
    if (!row) throw new StorageError('NOT_FOUND');
    return JSON.parse(row.body) as Operation;
  }
  #task(task: Task): void {
    this.#db
      .prepare(
        'INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(task.id, task.projectId, json(task));
  }
  #event(taskId: string, kind: string, payload: unknown): void {
    this.#db
      .prepare('INSERT INTO events(task_id,kind,payload) VALUES(?,?,?)')
      .run(taskId, kind, json(payload));
  }
  #operation(op: Operation): void {
    this.#db
      .prepare(
        'INSERT INTO operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(op.attemptId, op.taskId, json(op));
    this.#db
      .prepare(
        'INSERT INTO outbox VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status',
      )
      .run(op.attemptId, op.status);
  }
  #command<T>(
    project: string,
    kind: string,
    key: string,
    input: unknown,
    fn: () => T,
  ): T {
    parse(idSchema, key);
    const hash = createHash('sha256').update(canonical(input)).digest('hex');
    return this.#transaction(() => {
      const old = this.#db
        .prepare(
          'SELECT hash,result FROM commands WHERE project_id=? AND kind=? AND key=?',
        )
        .get(project, kind, key) as
        { hash: string; result: string } | undefined;
      if (old) {
        if (old.hash !== hash) throw new StorageError('CONFLICT');
        return JSON.parse(old.result) as T;
      }
      const result = fn();
      this.#db
        .prepare('INSERT INTO commands VALUES(?,?,?,?,?)')
        .run(project, kind, key, hash, json(result));
      this.#fault(kind + '.before_commit');
      return result;
    });
  }
  create(key: string, input: CreateTask): Task {
    const task = createTask(input);
    return this.#command(task.projectId, 'create', key, task, () => {
      if (this.#db.prepare('SELECT id FROM tasks WHERE id=?').get(task.id))
        throw new StorageError('DUPLICATE_IDENTITY');
      this.#task(task);
      this.#event(task.id, 'task.created', task);
      return task;
    });
  }
  #version(task: Task, expected: number): void {
    if (task.rowVersion !== expected) throw new StorageError('CONFLICT');
  }
  queue(key: string, id: string, expectedVersion: number): Task {
    const task = this.getTask(id);
    return this.#command(
      task.projectId,
      'queue',
      key,
      { id, expectedVersion },
      () => {
        const current = this.getTask(id);
        this.#version(current, expectedVersion);
        const unresolved = this.#db
          .prepare('SELECT body FROM operations WHERE task_id=?')
          .all(id) as { body: string }[];
        if (
          this.providers.unresolved(id) ||
          unresolved.some((row) =>
            ['prepared', 'sending', 'running', 'unknown'].includes(
              (JSON.parse(row.body) as Operation).status,
            ),
          )
        )
          throw new StorageError('UNRESOLVED_OPERATION');
        const next = transitionTask(current, 'queued');
        this.#task(next);
        this.#event(id, 'task.state_changed', next);
        return next;
      },
    );
  }
  dispatch(key: string, input: Dispatch): Operation {
    const spec = z
      .strictObject({
        ...runRequestSchema.shape,
        workspaceId: idSchema,
        sessionId: idSchema,
        expectedVersion: z.number().int().nonnegative(),
      })
      .parse(input);
    return this.#command(
      this.getTask(spec.taskId).projectId,
      'dispatch',
      key,
      spec,
      () => {
        const task = this.getTask(spec.taskId);
        this.#version(task, spec.expectedVersion);
        if (
          this.providers.hasAttempt(spec.attemptId) ||
          this.#db
            .prepare('SELECT id FROM operations WHERE id=?')
            .get(spec.attemptId)
        )
          throw new StorageError('DUPLICATE_IDENTITY');
        const resources = [
          'workspace:' + spec.workspaceId,
          'session:' + spec.sessionId,
          'worker:' + spec.workerId,
        ];
        for (const resource of resources)
          if (
            this.providers.occupied(resource) ||
            this.#db
              .prepare('SELECT resource FROM reservations WHERE resource=?')
              .get(resource)
          )
            throw new StorageError('LEASE_BUSY');
        const next = transitionTask(
          { ...task, attemptId: spec.attemptId },
          'running',
        );
        const op: Operation = {
          ...spec,
          token: randomBytes(32).toString('hex'),
          generation: this.#generation,
          status: 'prepared',
          sequence: 0,
          reason: null,
        };
        this.#task(next);
        this.#operation(op);
        for (const resource of resources)
          this.#db
            .prepare('INSERT INTO reservations VALUES(?,?)')
            .run(resource, spec.attemptId);
        this.#event(task.id, 'attempt.reserved', {
          attemptId: spec.attemptId,
          generation: this.#generation,
        });
        return op;
      },
    );
  }
  #bound(id: string, token: string): Operation {
    const op = this.getOperation(id);
    if (op.token !== token || op.generation !== this.#generation)
      throw new StorageError('STALE_FENCE');
    return op;
  }
  markSending(id: string, token: string): Operation {
    return this.#transaction(() => {
      const op = this.#bound(id, token);
      if (op.status !== 'prepared')
        throw new StorageError('UNRESOLVED_OPERATION');
      const next = { ...op, status: 'sending' as const };
      this.#operation(next);
      this.#fault('send.before_commit');
      return next;
    });
  }
  #fail(op: Operation, reason: Reason): void {
    const status =
      reason === 'cancelled'
        ? 'cancelled'
        : reason === 'unknown' || reason === 'invalid_event'
          ? 'unknown'
          : 'failed';
    this.#operation({ ...op, status, reason });
    const task = this.getTask(op.taskId);
    const next =
      reason === 'cancelled'
        ? transitionTask(transitionTask(task, 'cancelling'), 'cancelled')
        : transitionTask(task, 'needs_attention');
    this.#task(next);
    this.#event(task.id, 'operation.' + reason, {
      attemptId: op.attemptId,
      reason,
    });
    if (status !== 'unknown') this.#release(op.attemptId);
  }
  #release(id: string): void {
    this.#db.prepare('DELETE FROM reservations WHERE operation_id=?').run(id);
  }
  fail(id: string, token: string, reason: Reason): void {
    this.#transaction(() => {
      const op = this.#bound(id, token);
      if (!['sending', 'running'].includes(op.status))
        throw new StorageError('CONFLICT');
      this.#fail(op, reason);
    });
  }
  receive(id: string, token: string, value: unknown): void {
    const invalid = this.#transaction(() => {
      const op = this.#bound(id, token);
      if (!['sending', 'running'].includes(op.status))
        throw new StorageError('CONFLICT');
      const result = eventSchema.safeParse(value);
      if (!result.success || !this.#validEvent(op, result.data)) {
        this.#fail(op, 'invalid_event');
        return true;
      }
      const event = result.data;
      const next = { ...op, sequence: event.sequence };
      if (event.kind === 'started') next.status = 'running';
      if (event.kind === 'completed') {
        next.status = 'completed';
        this.#task(
          transitionTask(
            {
              ...this.getTask(op.taskId),
              treeHash: event.treeHash,
              artifactSetHash: event.artifactSetHash,
            },
            'verifying',
          ),
        );
      }
      this.#operation(next);
      // Stream text is untrusted and may contain secrets. Retain only size in the durable journal.
      this.#event(
        op.taskId,
        'attempt.' + event.kind,
        event.kind === 'output'
          ? { sequence: event.sequence, bytes: Buffer.byteLength(event.text) }
          : event,
      );
      if (
        event.kind === 'failed' ||
        event.kind === 'quota' ||
        event.kind === 'unknown' ||
        event.kind === 'cancelled'
      )
        this.#fail(
          next,
          event.kind === 'failed' ? 'worker_failed' : event.kind,
        );
      this.#fault('event.before_commit');
      return false;
    });
    if (invalid) throw new StorageError('INVALID_EVENT');
  }
  #validEvent(op: Operation, event: RuntimeEvent): boolean {
    return (
      event.taskId === op.taskId &&
      event.attemptId === op.attemptId &&
      event.workerId === op.workerId &&
      event.sequence === op.sequence + 1 &&
      event.sequence <= 256 &&
      (event.kind === 'cancelled' ||
        (op.status === 'sending'
          ? event.kind === 'started'
          : event.kind !== 'started'))
    );
  }
  recover(): string[] {
    return this.#transaction(() => {
      const rows = this.#db.prepare('SELECT body FROM operations').all() as {
        body: string;
      }[];
      const affected: string[] = this.providers.recover();
      for (const row of rows) {
        const op = JSON.parse(row.body) as Operation;
        if (
          op.status === 'completed' &&
          this.getTask(op.taskId).state === 'verifying' &&
          op.generation !== this.#generation
        ) {
          this.finishVerification(op.taskId, undefined);
          affected.push(op.attemptId);
          continue;
        }
        if (
          ['sending', 'running'].includes(op.status) ||
          (op.status === 'prepared' && op.generation !== this.#generation)
        ) {
          this.#fail(op, 'unknown');
          affected.push(op.attemptId);
        }
      }
      return affected;
    });
  }
  // Only trusted controller code may supply reconciliation evidence. No public HTTP route exposes this method.
  reconcile(id: string, outcome: 'not_started' | 'stopped'): void {
    z.enum(['not_started', 'stopped']).parse(outcome);
    this.#transaction(() => {
      const op = this.getOperation(id);
      if (op.status !== 'unknown') throw new StorageError('CONFLICT');
      this.#operation({ ...op, status: 'failed', reason: 'unknown' });
      this.#release(id);
      this.#event(op.taskId, 'operation.reconciled', {
        attemptId: id,
        outcome,
      });
    });
  }
  finishVerification(
    id: string,
    evidence: Evidence | undefined,
    failed = false,
  ): Task {
    return this.#transaction(() => {
      const task = this.getTask(id);
      const next = transitionTask(
        task,
        failed
          ? 'needs_rework'
          : evidence
            ? 'ready_for_acceptance'
            : 'needs_attention',
        evidence,
      );
      if (evidence && !failed)
        this.#db
          .prepare('INSERT OR REPLACE INTO evidence VALUES(?,?)')
          .run(id, json(evidence));
      if (!evidence || failed) {
        const op = this.getOperation(task.attemptId!);
        this.#operation({
          ...op,
          status: !evidence && !failed ? 'unknown' : op.status,
          reason: 'verifier_failed',
        });
      }
      if (evidence || failed) this.#release(task.attemptId!);
      this.#task(next);
      this.#event(id, 'task.state_changed', {
        state: next.state,
        reason: !evidence || failed ? 'verifier_failed' : null,
      });
      return next;
    });
  }
  accept(key: string, id: string, expectedVersion: number): Task {
    return this.#command(
      this.getTask(id).projectId,
      'accept',
      key,
      { id, expectedVersion },
      () => {
        const task = this.getTask(id);
        this.#version(task, expectedVersion);
        if (task.nativeQualification)
          throw new StorageError('NATIVE_ACCEPTANCE_REQUIRED');
        const row = this.#db
          .prepare('SELECT body FROM evidence WHERE task_id=?')
          .get(id) as { body: string } | undefined;
        const next = transitionTask(
          task,
          'accepted',
          row ? (JSON.parse(row.body) as Evidence) : undefined,
        );
        this.#task(next);
        this.#event(id, 'task.accepted', next);
        return next;
      },
    );
  }
  prepareNativeAcceptance(
    key: string,
    connectionId: string,
    expectedVersion: number,
    objects: ArtifactStore,
  ) {
    const original = this.providers.get(connectionId);
    return this.#command(
      this.getTask(original.taskId).projectId,
      'native.prepare',
      key,
      { connectionId, expectedVersion },
      () => {
        const evidence = this.providers.acceptanceEvidence(connectionId);
        const task = this.getTask(evidence.taskId);
        this.#version(task, expectedVersion);
        if (task.state !== 'needs_attention')
          throw new StorageError('ILLEGAL_TRANSITION');
        verifiedWorkspaceObjects(objects, evidence);
        const verifying = transitionTask(task, 'verifying');
        const next = nativeAcceptanceTask(
          {
            ...verifying,
            treeHash: evidence.treeHash,
            artifactSetHash: evidence.artifactSetHash,
          },
          'ready_for_acceptance',
          evidence,
        );
        this.#task(next);
        this.#db
          .prepare('INSERT OR REPLACE INTO evidence VALUES(?,?)')
          .run(task.id, json(evidence));
        const review = {
          taskId: task.id,
          connectionId,
          rowVersion: next.rowVersion,
          runtimeKind: evidence.runtimeKind,
          classification: evidence.classification,
          treeHash: evidence.treeHash,
          artifactSetHash: evidence.artifactSetHash,
          evidenceHash: createHash('sha256')
            .update(canonical(evidence))
            .digest('hex'),
        };
        this.#event(task.id, 'native.ready_for_acceptance', review);
        return review;
      },
    );
  }
  acceptNative(key: string, input: unknown, objects: ArtifactStore): Task {
    const spec = nativeAcceptanceSchema.parse(input);
    const original = this.providers.get(spec.connectionId);
    return this.#command(
      this.getTask(original.taskId).projectId,
      'native.accept',
      key,
      spec,
      () => {
        const task = this.getTask(original.taskId);
        this.#version(task, spec.expectedVersion);
        const evidence = this.providers.acceptanceEvidence(spec.connectionId);
        const row = this.#db
          .prepare('SELECT body FROM evidence WHERE task_id=?')
          .get(task.id) as { body: string } | undefined;
        if (!row) throw new StorageError('EVIDENCE_REQUIRED');
        const saved = nativeEvidenceSchema.parse(JSON.parse(row.body));
        const evidenceHash = createHash('sha256')
          .update(canonical(evidence))
          .digest('hex');
        if (
          spec.classification !== evidence.classification ||
          canonical(saved) !== canonical(evidence) ||
          evidenceHash !== spec.reviewedEvidenceHash
        )
          throw new StorageError('STALE_EVIDENCE');
        verifiedWorkspaceObjects(objects, evidence);
        const next = nativeAcceptanceTask(task, 'accepted', evidence);
        this.#task(next);
        this.providers.markAccepted(spec.connectionId);
        this.#event(task.id, 'native.accepted', {
          actorId: spec.actorId,
          classification: spec.classification,
          runtimeKind: evidence.runtimeKind,
          connectionId: spec.connectionId,
          evidenceHash,
          treeHash: evidence.treeHash,
          artifactSetHash: evidence.artifactSetHash,
          attemptId: evidence.attemptId,
          workRevision: evidence.workRevision,
        });
        return next;
      },
    );
  }
  events(after: number, limit = 100): JournalEvent[] {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new StorageError('INVALID_INPUT');
    return (
      this.#db
        .prepare(
          'SELECT sequence,task_id,kind,payload FROM events WHERE sequence>? ORDER BY sequence LIMIT ?',
        )
        .all(after, limit) as {
        sequence: number;
        task_id: string;
        kind: string;
        payload: string;
      }[]
    ).map((row) => ({
      sequence: row.sequence,
      taskId: row.task_id,
      kind: row.kind,
      payload: JSON.parse(row.payload) as unknown,
    }));
  }
  /** The latest event of one kind for one task, however long the journal is. */
  lastEvent(taskId: string, kind: string): JournalEvent | undefined {
    const row = this.#db
      .prepare(
        'SELECT sequence,task_id,kind,payload FROM events WHERE task_id=? AND kind=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(taskId, kind) as
      | { sequence: number; task_id: string; kind: string; payload: string }
      | undefined;
    return row
      ? {
          sequence: row.sequence,
          taskId: row.task_id,
          kind: row.kind,
          payload: JSON.parse(row.payload) as unknown,
        }
      : undefined;
  }
  recordArtifact(
    taskId: string,
    artifacts: ArtifactStore,
    bytes: Buffer,
  ): string {
    this.#owned();
    const task = this.getTask(taskId);
    const hash = artifacts.put(bytes);
    this.#transaction(() => {
      this.#version(this.getTask(taskId), task.rowVersion);
      this.#db
        .prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?,?)')
        .run(hash, taskId, task.workRevision);
      this.#fault('artifact.before_commit');
    });
    return hash;
  }
  artifactHashes(): string[] {
    return (
      this.#db
        .prepare('SELECT DISTINCT hash FROM artifacts ORDER BY hash')
        .all() as { hash: string }[]
    ).map((row) => row.hash);
  }
  async backup(path: string): Promise<void> {
    this.#owned();
    await this.#db.backup(path);
  }
}
