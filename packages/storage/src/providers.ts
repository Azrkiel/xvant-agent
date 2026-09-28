import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from '../../contracts/src/index.ts';
import {
  nativeVerificationSchema,
  type NativeVerification,
} from '../../contracts/src/native-evidence.ts';
import type { ArtifactStore } from './artifacts.ts';
import {
  nativeIdSchema,
  providerWorkerSchema,
} from '../../contracts/src/providers.ts';

export const providerMigration = `
CREATE TABLE provider_connections(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL);
CREATE TABLE provider_entries(sequence INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL REFERENCES provider_connections(id), body TEXT NOT NULL);
CREATE TABLE provider_reservations(resource TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES provider_connections(id));
`;
const specSchema = z.strictObject({
  connectionId: idSchema,
  taskId: idSchema,
  attemptId: idSchema,
  workspaceId: idSchema,
  expectedVersion: z.number().int().nonnegative(),
  classification: z.literal('offline'),
  worker: providerWorkerSchema.extend({ mode: z.literal('managed') }),
});
export type ProviderDispatch = z.input<typeof specSchema>;
export interface ProviderConnection extends ProviderDispatch {
  token: string;
  generation: number;
  workRevision: number;
  status:
    | 'open'
    | 'unknown'
    | 'result_pending'
    | 'verifying'
    | 'verified'
    | 'verification_failed'
    | 'reconciled'
    | 'accepted';
  verification?: NativeVerification;
  nativeRunId: string | null;
  sessionBound?: boolean;
  outcome: 'completed' | 'cancelled' | 'failed' | null;
  reconciliation: {
    outcome: 'stopped' | 'not_started';
    generation: number;
  } | null;
}
export interface ProviderEntry {
  sequence: number;
  direction: 'out' | 'in';
  sha256: string;
  bytes: number;
  rpcId?: number | string;
  method?: string;
  frame?: string;
}
interface Host {
  transaction: <T>(fn: () => T) => T;
  generation: number;
  start: (spec: ProviderDispatch) => number;
  attention: (taskId: string) => void;
  fault: (point: string) => void;
  task: (taskId: string) => {
    attemptId?: string | undefined;
    workRevision: number;
    requiredCheckIds: string[];
  };
}
function fail(code: string): never {
  throw new Error(code);
}

/** Host-only journal. Offline qualification does not authorize launching a provider. */
export class ProviderJournal {
  private readonly db: Database.Database;
  private readonly host: Host;
  constructor(db: Database.Database, host: Host) {
    this.db = db;
    this.host = host;
  }
  get(id: string): ProviderConnection {
    const row = this.db
      .prepare('SELECT body FROM provider_connections WHERE id=?')
      .get(idSchema.parse(id)) as { body: string } | undefined;
    if (!row) fail('NOT_FOUND');
    return JSON.parse(row.body) as ProviderConnection;
  }
  private save(connection: ProviderConnection): void {
    this.db
      .prepare('UPDATE provider_connections SET body=? WHERE id=?')
      .run(JSON.stringify(connection), connection.connectionId);
  }
  private active(): ProviderConnection[] {
    return (
      this.db.prepare('SELECT body FROM provider_connections').all() as {
        body: string;
      }[]
    )
      .map((row) => JSON.parse(row.body) as ProviderConnection)
      .filter((value) => !['reconciled', 'accepted'].includes(value.status));
  }
  unresolved(taskId: string): boolean {
    return this.active().some((value) => value.taskId === taskId);
  }
  hasAttempt(id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT id FROM provider_connections WHERE json_extract(body,'$.attemptId')=?",
      )
      .get(id);
  }
  occupied(resource: string): boolean {
    return !!this.db
      .prepare('SELECT resource FROM provider_reservations WHERE resource=?')
      .get(resource);
  }
  reserve(input: unknown): ProviderConnection {
    const spec = specSchema.parse(input);
    return this.host.transaction(() => {
      if (
        this.db
          .prepare('SELECT id FROM provider_connections WHERE id=?')
          .get(spec.connectionId) ||
        this.hasAttempt(spec.attemptId) ||
        this.db
          .prepare('SELECT id FROM operations WHERE id=?')
          .get(spec.attemptId)
      )
        fail('DUPLICATE_IDENTITY');
      if (this.unresolved(spec.taskId)) fail('UNRESOLVED_OPERATION');
      const resources = [
        'workspace:' + spec.workspaceId,
        'worker:' + spec.worker.id,
        // Endpoint aliases do not create independent native sessions.
        'native:' +
          JSON.stringify([
            spec.worker.runtimeKind,
            spec.worker.hostId,
            spec.worker.nativeSessionId,
          ]),
      ];
      for (const resource of resources)
        if (
          this.occupied(resource) ||
          this.db
            .prepare('SELECT resource FROM reservations WHERE resource=?')
            .get(resource)
        )
          fail('LEASE_BUSY');
      const workRevision = this.host.start(spec);
      const connection: ProviderConnection = {
        ...spec,
        workRevision,
        generation: this.host.generation,
        token: randomBytes(32).toString('hex'),
        status: 'open',
        nativeRunId: null,
        outcome: null,
        reconciliation: null,
      };
      this.db
        .prepare('INSERT INTO provider_connections VALUES(?,?,?)')
        .run(spec.connectionId, spec.taskId, JSON.stringify(connection));
      for (const resource of resources)
        this.db
          .prepare('INSERT INTO provider_reservations VALUES(?,?)')
          .run(resource, spec.connectionId);
      this.host.fault('provider.reserve.before_commit');
      return connection;
    });
  }
  private bound(id: string, token: string): ProviderConnection {
    const value = this.get(id);
    if (value.token !== token || value.generation !== this.host.generation)
      fail('STALE_FENCE');
    return value;
  }
  assertWritable(id: string, token: string): void {
    this.host.transaction(() => {
      if (this.bound(id, token).status !== 'open') fail('UNRESOLVED_OPERATION');
    });
  }
  private append(id: string, value: Omit<ProviderEntry, 'sequence'>): void {
    const count = this.db
      .prepare('SELECT count(*) n FROM provider_entries WHERE connection_id=?')
      .get(id) as { n: number };
    if (count.n >= 4096) fail('LIMIT_EXCEEDED');
    this.db
      .prepare('INSERT INTO provider_entries(connection_id,body) VALUES(?,?)')
      .run(id, JSON.stringify(value));
  }
  recordIntent(
    id: string,
    token: string,
    intent: { id: number; method: string; frame: string },
  ): void {
    this.host.transaction(() => {
      this.assertWritable(id, token);
      if (
        !Number.isSafeInteger(intent.id) ||
        intent.id < 1 ||
        Buffer.byteLength(intent.frame) > 65536
      )
        fail('INVALID_INPUT');
      // Never replay an intent, even if byte-identical: a prior write may have escaped.
      if (
        this.entries(id).some(
          (entry) => entry.direction === 'out' && entry.rpcId === intent.id,
        )
      )
        fail('UNRESOLVED_OPERATION');
      this.append(id, {
        direction: 'out',
        rpcId: intent.id,
        method: intent.method,
        frame: intent.frame,
        sha256: createHash('sha256').update(intent.frame).digest('hex'),
        bytes: Buffer.byteLength(intent.frame),
      });
      this.host.fault('provider.send.before_commit');
    });
  }
  recordMessage(
    id: string,
    token: string,
    message: Record<string, unknown>,
  ): void {
    this.host.transaction(() => {
      this.assertWritable(id, token);
      const bytes = JSON.stringify(message);
      if (Buffer.byteLength(bytes) > 65536) fail('LIMIT_EXCEEDED');
      // Output/error bodies can contain secrets. Persist a content digest and routing metadata only.
      this.append(id, {
        direction: 'in',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: Buffer.byteLength(bytes),
        ...(typeof message.id === 'number' || typeof message.id === 'string'
          ? { rpcId: message.id }
          : {}),
        ...(typeof message.method === 'string'
          ? { method: message.method }
          : {}),
      });
      this.host.fault('provider.receive.before_commit');
    });
  }
  entries(id: string): ProviderEntry[] {
    this.get(id);
    return (
      this.db
        .prepare(
          'SELECT sequence,body FROM provider_entries WHERE connection_id=? ORDER BY sequence',
        )
        .all(id) as { sequence: number; body: string }[]
    ).map((row) => ({
      ...(JSON.parse(row.body) as Omit<ProviderEntry, 'sequence'>),
      sequence: row.sequence,
    }));
  }
  /** Bind a validated creation reply once, before any turn can be sent. */
  bindSession(id: string, token: string, nativeSessionId: string): void {
    nativeIdSchema.parse(nativeSessionId);
    this.host.transaction(() => {
      this.assertWritable(id, token);
      const connection = this.bound(id, token);
      const outgoing = this.entries(id).filter(
        (entry) => entry.direction === 'out',
      );
      if (
        connection.sessionBound ||
        connection.nativeRunId ||
        outgoing.filter((entry) => entry.method === 'thread/start').length !==
          1 ||
        outgoing.some((entry) => entry.method === 'turn/start')
      )
        fail('CONFLICT');
      const resource = (session: string) =>
        'native:' +
        JSON.stringify([
          connection.worker.runtimeKind,
          connection.worker.hostId,
          session,
        ]);
      const previous = resource(connection.worker.nativeSessionId);
      const next = resource(nativeSessionId);
      if (next !== previous) {
        if (
          this.occupied(next) ||
          this.db
            .prepare('SELECT resource FROM reservations WHERE resource=?')
            .get(next)
        )
          fail('LEASE_BUSY');
        this.db
          .prepare('INSERT INTO provider_reservations VALUES(?,?)')
          .run(next, id);
        this.db
          .prepare(
            'DELETE FROM provider_reservations WHERE resource=? AND connection_id=?',
          )
          .run(previous, id);
      }
      this.save({
        ...connection,
        worker: { ...connection.worker, nativeSessionId },
        sessionBound: true,
      });
      this.host.fault('provider.session.before_commit');
    });
  }
  bindRun(id: string, token: string, nativeRunId: string): void {
    nativeIdSchema.parse(nativeRunId);
    this.host.transaction(() => {
      this.assertWritable(id, token);
      const connection = this.bound(id, token);
      if (
        connection.nativeRunId !== null &&
        connection.nativeRunId !== nativeRunId
      )
        fail('INVALID_EVENT');
      this.save({ ...connection, nativeRunId });
    });
  }
  finish(
    id: string,
    token: string,
    nativeRunId: string,
    outcome: 'completed' | 'cancelled' | 'failed',
  ): void {
    z.enum(['completed', 'cancelled', 'failed']).parse(outcome);
    this.host.transaction(() => {
      this.assertWritable(id, token);
      const connection = this.bound(id, token);
      if (!connection.nativeRunId || connection.nativeRunId !== nativeRunId)
        fail('INVALID_EVENT');
      this.save({ ...connection, status: 'result_pending', outcome });
      // Native completion is not simulator evidence and cannot pass acceptance.
      this.host.attention(connection.taskId);
      this.host.fault('provider.result.before_commit');
    });
  }
  unknown(id: string, token: string): void {
    this.host.transaction(() => {
      const connection = this.bound(id, token);
      if (connection.status !== 'open') return;
      this.save({ ...connection, status: 'unknown' });
      this.host.attention(connection.taskId);
    });
  }
  recover(): string[] {
    return this.host.transaction(() => {
      const affected: string[] = [];
      for (const connection of this.active()) {
        if (
          !['open', 'verifying'].includes(connection.status) ||
          connection.generation === this.host.generation
        )
          continue;
        this.save({ ...connection, status: 'unknown' });
        this.host.attention(connection.taskId);
        affected.push(connection.attemptId);
      }
      return affected;
    });
  }
  /** Trusted host evidence only; never exposed as a provider message or HTTP command. */
  reconcile(id: string, outcome: 'stopped' | 'not_started'): void {
    z.enum(['stopped', 'not_started']).parse(outcome);
    this.host.transaction(() => {
      const connection = this.get(id);
      if (
        ![
          'unknown',
          'result_pending',
          'verified',
          'verification_failed',
        ].includes(connection.status)
      )
        fail('CONFLICT');
      this.save({
        ...connection,
        status: 'reconciled',
        reconciliation: { outcome, generation: this.host.generation },
      });
      this.db
        .prepare('DELETE FROM provider_reservations WHERE connection_id=?')
        .run(id);
    });
  }
  beginVerification(id: string, token: string): ProviderConnection {
    return this.host.transaction(() => {
      const connection = this.bound(id, token);
      if (
        connection.status !== 'result_pending' ||
        connection.outcome !== 'completed' ||
        !connection.nativeRunId
      )
        fail('VERIFICATION_UNAVAILABLE');
      const task = this.host.task(connection.taskId);
      if (
        task.attemptId !== connection.attemptId ||
        task.workRevision !== connection.workRevision
      )
        fail('STALE_EVIDENCE');
      const next = { ...connection, status: 'verifying' as const };
      this.save(next);
      this.host.fault('provider.verify.before_commit');
      return next;
    });
  }
  acceptanceEvidence(id: string, historical = false) {
    const connection = this.get(id);
    if (
      !(
        connection.status === 'verified' ||
        (historical && connection.status === 'accepted')
      ) ||
      connection.outcome !== 'completed'
    )
      fail('EVIDENCE_REQUIRED');
    const result = nativeVerificationSchema.parse(connection.verification);
    if (result.status !== 'passed') fail('CHECK_FAILED');
    const evidence = result.evidence;
    const expected = {
      taskId: connection.taskId,
      attemptId: connection.attemptId,
      workRevision: connection.workRevision,
      generation: connection.generation,
      connectionId: id,
      workspaceId: connection.workspaceId,
      hostId: connection.worker.hostId,
      runtimeKind: connection.worker.runtimeKind,
      classification: connection.classification,
      nativeSessionId: connection.worker.nativeSessionId,
      nativeRunId: connection.nativeRunId,
    };
    if (
      (Object.keys(expected) as (keyof typeof expected)[]).some(
        (key) => evidence[key] !== expected[key],
      )
    )
      fail('STALE_EVIDENCE');
    return evidence;
  }
  /** Called only inside Store's explicit acceptance transaction. */
  markAccepted(id: string): void {
    this.host.transaction(() => {
      this.acceptanceEvidence(id);
      this.save({ ...this.get(id), status: 'accepted' });
      this.db
        .prepare('DELETE FROM provider_reservations WHERE connection_id=?')
        .run(id);
    });
  }
  finishVerification(
    id: string,
    token: string,
    input: unknown,
    objects: ArtifactStore,
  ): NativeVerification {
    const verification = nativeVerificationSchema.parse(input);
    return this.host.transaction(() => {
      const connection = this.bound(id, token);
      if (connection.status !== 'verifying') fail('VERIFICATION_UNAVAILABLE');
      const task = this.host.task(connection.taskId);
      if (
        task.attemptId !== connection.attemptId ||
        task.workRevision !== connection.workRevision
      )
        fail('STALE_EVIDENCE');
      if (verification.status !== 'unknown') {
        const evidence = verification.evidence;
        const expected = {
          taskId: connection.taskId,
          attemptId: connection.attemptId,
          workRevision: connection.workRevision,
          connectionId: id,
          workspaceId: connection.workspaceId,
          generation: connection.generation,
          hostId: connection.worker.hostId,
          runtimeKind: connection.worker.runtimeKind,
          classification: connection.classification,
          nativeSessionId: connection.worker.nativeSessionId,
          nativeRunId: connection.nativeRunId,
        };
        if (
          (Object.keys(expected) as (keyof typeof expected)[]).some(
            (key) => evidence[key] !== expected[key],
          ) ||
          evidence.receipts.length !== task.requiredCheckIds.length ||
          evidence.receipts.some(
            (receipt) => !task.requiredCheckIds.includes(receipt.checkId),
          )
        )
          fail('STALE_EVIDENCE');
        const manifest = z
          .strictObject({
            version: z.literal(1),
            hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1025),
          })
          .parse(JSON.parse(objects.get(evidence.artifactSetHash).toString()));
        if (!manifest.hashes.includes(evidence.treeHash))
          fail('INVALID_EVIDENCE');
        for (const hash of new Set([
          ...manifest.hashes,
          evidence.artifactSetHash,
        ])) {
          objects.get(hash);
          this.db
            .prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?,?)')
            .run(hash, connection.taskId, connection.workRevision);
        }
      }
      this.save({
        ...connection,
        verification,
        status:
          verification.status === 'unknown'
            ? 'unknown'
            : verification.status === 'passed'
              ? 'verified'
              : 'verification_failed',
      });
      this.host.fault('provider.verified.before_commit');
      return verification;
    });
  }
}
