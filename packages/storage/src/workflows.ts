import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from '../../contracts/src/index.ts';

export const workflowMigration = `
CREATE TABLE work_checkpoints(graph_id TEXT PRIMARY KEY REFERENCES work_graphs(id), body TEXT NOT NULL);
CREATE TABLE work_actions(graph_id TEXT NOT NULL REFERENCES work_graphs(id), slot TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(graph_id,slot));
`;
export const recoveryMigration = `
CREATE TABLE work_dispatches(id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES work_graphs(id), body TEXT NOT NULL);
CREATE INDEX work_dispatch_graph ON work_dispatches(graph_id);
CREATE TABLE work_recoveries(id TEXT PRIMARY KEY, graph_id TEXT NOT NULL REFERENCES work_graphs(id), body TEXT NOT NULL);
CREATE INDEX work_recovery_graph ON work_recoveries(graph_id);
`;
const slotSchema = z.string().min(1).max(256);
const dispatchId = z.uuid();
const fields = {
  slot: slotSchema,
  kind: z.enum(['initialize', 'turn', 'check', 'apply']),
  generation: z.number().int().positive(),
  input: z.json(),
  operationId: z.uuid().optional(),
};
const actionSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...fields, status: z.literal('prepared') }),
  z.strictObject({
    ...fields,
    status: z.literal('dispatching'),
    dispatchId: dispatchId.optional(),
  }),
  z.strictObject({
    ...fields,
    status: z.literal('completed'),
    dispatchId: dispatchId.optional(),
    result: z.json(),
  }),
]);
export type WorkAction = z.infer<typeof actionSchema>;
export type DispatchingAction = Extract<WorkAction, { status: 'dispatching' }>;
export const processIdentity = z.strictObject({
  pid: z.number().int().positive(),
  boot: z.uuid(),
  namespace: z.string().regex(/^pid:\[\d+\]$/),
  start: z.string().regex(/^\d+$/),
});
export type WorkerProcessIdentity = z.infer<typeof processIdentity>;
const dispatchSchema = z.strictObject({
  id: dispatchId,
  slot: slotSchema,
  generation: z.number().int().positive(),
  attemptId: z.string().min(1),
  owner: idSchema,
  operationId: z.string().min(1),
  resources: z.array(z.string().min(1)),
  adapter: z.string().min(1).nullable(),
  armed: z.boolean(),
  released: z.boolean(),
  processes: z.array(processIdentity),
  observation: z.json().optional(),
});
export type WorkDispatch = z.infer<typeof dispatchSchema>;
type DispatchDescriptor = Pick<WorkDispatch, 'resources' | 'adapter'> & {
  attemptId?: string | undefined;
};
export interface RecoveryProbe {
  classification:
    | 'not_started'
    | 'owned_running'
    | 'completed_verifiable'
    | 'stopped_incomplete'
    | 'unresolved';
  source: string;
  evidence: z.infer<ReturnType<typeof z.json>>;
  detail: string;
  operatorAction?: string;
}
export interface RecoveryDecision extends RecoveryProbe {
  id: string;
  slot: string;
  kind: WorkAction['kind'];
  attemptId: string;
  dispatchId: string | null;
  operationId: string;
  dispatchGeneration: number;
  owner: string;
  generation: number;
  observedAt: number;
  decision: 'resume' | 'retry' | 'block';
}

interface Host {
  transaction: <T>(fn: () => T) => T;
  generation: () => number;
  owner: string;
  now: () => number;
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

  interrupted(): string[] {
    return (
      this.#db
        .prepare(
          `
      SELECT DISTINCT graph_id FROM work_actions WHERE json_extract(body,'$.status')='dispatching'
    `,
        )
        .all() as { graph_id: string }[]
    ).map(({ graph_id }) => graph_id);
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
        operationId: randomUUID(),
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
    descriptor?: DispatchDescriptor,
  ): DispatchingAction {
    return this.atomic(() => {
      const action = this.action(id, slot);
      if (!action || action.status !== 'prepared')
        throw new Error('UNRESOLVED_WORKFLOW_ACTION');
      const operationId =
        action.operationId ?? (descriptor ? randomUUID() : undefined);
      const next = {
        ...action,
        ...(operationId ? { operationId } : {}),
        status: 'dispatching' as const,
        generation: this.#host.generation(),
        ...(descriptor ? { dispatchId: randomUUID() } : {}),
      };
      if (descriptor) {
        const dispatch = dispatchSchema.parse({
          ...descriptor,
          attemptId: descriptor.attemptId ?? operationId,
          operationId,
          id: next.dispatchId,
          slot,
          generation: next.generation,
          owner: this.#host.owner,
          armed: false,
          released: false,
          processes: [],
        });
        this.#db
          .prepare('INSERT INTO work_dispatches VALUES(?,?,?)')
          .run(dispatch.id, id, JSON.stringify(dispatch));
      }
      this.#replace(id, next);
      return next;
    });
  }

  complete(
    id: string,
    slot: string,
    generation: number,
    value: unknown,
    dispatchId?: string,
  ): void {
    this.atomic(() => {
      const action = this.action(id, slot);
      if (
        !action ||
        generation !== this.#host.generation() ||
        action.generation !== generation ||
        (action.status !== 'prepared' && action.dispatchId !== dispatchId)
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
      const dispatch = this.dispatch(id, action);
      if (dispatch && !dispatch.armed) throw new Error('STALE_FENCE');
      if (
        dispatch?.observation !== undefined &&
        JSON.stringify(dispatch.observation) !== JSON.stringify(value)
      )
        throw new Error('CONFLICT');
      this.#replace(id, next);
      if (dispatch) this.#saveDispatch({ ...dispatch, released: true });
    });
  }

  dispatch(id: string, action: DispatchingAction): WorkDispatch | null {
    if (!action.dispatchId) return null;
    const row = this.#db
      .prepare('SELECT body FROM work_dispatches WHERE id=? AND graph_id=?')
      .get(action.dispatchId, id) as { body: string } | undefined;
    const dispatch = dispatchSchema.parse(row ? JSON.parse(row.body) : null);
    if (
      dispatch.slot !== action.slot ||
      dispatch.generation !== action.generation ||
      dispatch.operationId !== action.operationId ||
      dispatch.id !== action.dispatchId
    )
      throw new Error('WORKFLOW_ACTION_INVALID');
    return dispatch;
  }

  #saveDispatch(dispatch: WorkDispatch): void {
    this.#db
      .prepare('UPDATE work_dispatches SET body=? WHERE id=?')
      .run(JSON.stringify(dispatch), dispatch.id);
  }

  /** Legacy provider admissions also respect a workflow holding that worker. */
  occupied(resource: string, ownAttempt?: string, ignoreGraph = ''): boolean {
    return (
      !!this.#db
        .prepare(
          `
      SELECT 1 FROM work_dispatches d, json_each(d.body, '$.resources') r
      WHERE r.value=? AND graph_id<>? AND json_extract(d.body,'$.armed')=1 AND json_extract(d.body,'$.released')=0
        AND NOT (json_extract(d.body,'$.attemptId')=? AND json_extract(d.body,'$.generation')=?)
      LIMIT 1
    `,
        )
        .get(
          resource,
          ignoreGraph,
          ownAttempt ?? '',
          this.#host.generation(),
        ) ||
      !!this.#db
        .prepare(
          `
      SELECT 1 FROM work_actions
      WHERE graph_id<>? AND json_extract(body,'$.kind')='turn' AND json_extract(body,'$.status')='dispatching'
        AND json_extract(body,'$.dispatchId') IS NULL AND ? IN (
          'worker:' || json_extract(body,'$.input.alias'),
          'workspace:' || json_extract(body,'$.input.taskId'),
          'worktree:' || json_extract(body,'$.input.workspace.path')
        )
      LIMIT 1
    `,
        )
        .get(ignoreGraph, resource)
    );
  }

  #current(id: string, action: DispatchingAction): WorkDispatch {
    this.#match(id, action);
    const dispatch = this.dispatch(id, action);
    if (
      !dispatch ||
      action.generation !== this.#host.generation() ||
      dispatch.released
    )
      throw new Error('STALE_FENCE');
    return dispatch;
  }

  #match(id: string, action: DispatchingAction): void {
    if (JSON.stringify(this.action(id, action.slot)) !== JSON.stringify(action))
      throw new Error('STALE_FENCE');
  }

  arm(
    id: string,
    action: DispatchingAction,
    occupied: (resource: string) => boolean,
  ): WorkDispatch {
    return this.atomic(() => {
      const dispatch = this.#current(id, action);
      if (dispatch.armed) throw new Error('CONFLICT');
      if (
        dispatch.resources.some(
          (resource) => this.occupied(resource) || occupied(resource),
        )
      )
        throw new Error('RECOVERY_RESOURCE_BUSY: ' + action.slot);
      const armed = { ...dispatch, armed: true };
      this.#saveDispatch(armed);
      return armed;
    });
  }

  effect<T>(id: string, action: DispatchingAction, run: () => T): T {
    return this.atomic(() => {
      if (!this.#current(id, action).armed) throw new Error('STALE_FENCE');
      return run();
    });
  }

  registerProcess(
    id: string,
    action: DispatchingAction,
    identity: WorkerProcessIdentity,
  ): void {
    this.atomic(() => {
      const dispatch = this.#current(id, action);
      if (!dispatch.armed) throw new Error('STALE_FENCE');
      const process = processIdentity.parse(identity);
      if (
        !dispatch.processes.some(
          (existing) => JSON.stringify(existing) === JSON.stringify(process),
        )
      )
        this.#saveDispatch({
          ...dispatch,
          processes: [...dispatch.processes, process],
        });
    });
  }

  observe(id: string, action: DispatchingAction, value: unknown): void {
    this.atomic(() => {
      const dispatch = this.#current(id, action);
      if (!dispatch.armed) throw new Error('STALE_FENCE');
      const observation = z.json().parse(value);
      if (
        dispatch.observation !== undefined &&
        JSON.stringify(observation) !== JSON.stringify(dispatch.observation)
      )
        throw new Error('CONFLICT');
      if (dispatch.observation === undefined)
        this.#saveDispatch({ ...dispatch, observation });
    });
  }

  recoveries(id: string): RecoveryDecision[] {
    return (
      this.#db
        .prepare(
          'SELECT body FROM work_recoveries WHERE graph_id=? ORDER BY rowid',
        )
        .all(idSchema.parse(id)) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as RecoveryDecision);
  }

  /** Commit a host probe and its legal transition together under the owner fence. */
  reconcile(
    id: string,
    action: DispatchingAction,
    observed: WorkDispatch | null,
    probe: RecoveryProbe,
    result?: unknown,
    remoteRetry = false,
  ): RecoveryDecision {
    return this.atomic(() => {
      this.#match(id, action);
      const dispatch = this.dispatch(id, action);
      if (
        JSON.stringify(dispatch) !== JSON.stringify(observed) ||
        dispatch?.released
      )
        throw new Error('STALE_FENCE');
      const completed =
        probe.classification === 'completed_verifiable' ||
        (probe.classification === 'stopped_incomplete' && result !== undefined);
      const retry = probe.classification === 'not_started';
      if (
        (retry && (!dispatch || dispatch.armed || result !== undefined)) ||
        (completed && (!dispatch?.armed || result === undefined))
      )
        throw new Error('WORKFLOW_RECOVERY_INVALID');
      if (
        remoteRetry &&
        (!dispatch?.armed ||
          !dispatch.adapter ||
          probe.classification !== 'unresolved' ||
          result !== undefined)
      )
        throw new Error('WORKFLOW_RECOVERY_INVALID');
      if (!completed && result !== undefined)
        throw new Error('WORKFLOW_RECOVERY_INVALID');
      if (
        completed &&
        dispatch?.observation !== undefined &&
        JSON.stringify(dispatch.observation) !== JSON.stringify(result)
      )
        throw new Error('CONFLICT');
      const operationId =
        action.operationId ??
        createHash('sha256')
          .update(JSON.stringify([id, action.slot]))
          .digest('hex');
      const legacyTask = (action.input as { taskId?: string } | null)?.taskId;
      const details = {
        ...probe,
        slot: action.slot,
        kind: action.kind,
        attemptId:
          dispatch?.attemptId ??
          (action.kind === 'turn' && legacyTask
            ? legacyTask + '-a1'
            : operationId),
        operationId,
        dispatchId: action.dispatchId ?? null,
        dispatchGeneration: action.generation,
        owner: this.#host.owner,
        generation: this.#host.generation(),
        decision: completed
          ? ('resume' as const)
          : retry || remoteRetry
            ? ('retry' as const)
            : ('block' as const),
      };
      const row = this.#db
        .prepare(
          `
        SELECT body FROM work_recoveries
        WHERE graph_id=? AND json_extract(body,'$.slot')=?
        ORDER BY rowid DESC LIMIT 1
      `,
        )
        .get(id, action.slot) as { body: string } | undefined;
      const previous = row
        ? (JSON.parse(row.body) as RecoveryDecision)
        : undefined;
      if (previous) {
        const { id: priorId, observedAt, ...priorDetails } = previous;
        if (JSON.stringify(priorDetails) === JSON.stringify(details))
          return { ...priorDetails, id: priorId, observedAt };
      }
      const entry = {
        ...details,
        id: randomUUID(),
        observedAt: this.#host.now(),
      };
      this.#db
        .prepare('INSERT INTO work_recoveries VALUES(?,?,?)')
        .run(entry.id, id, JSON.stringify(entry));
      if (completed)
        this.#replace(
          id,
          actionSchema.parse({ ...action, status: 'completed', result }),
        );
      if (retry)
        this.#replace(id, {
          slot: action.slot,
          kind: action.kind,
          input: action.input,
          operationId: action.operationId,
          generation: action.generation,
          status: 'prepared',
        });
      if ((completed || retry) && dispatch)
        this.#saveDispatch({ ...dispatch, released: true });
      return entry;
    });
  }

  #replace(id: string, action: WorkAction): void {
    this.#db
      .prepare('UPDATE work_actions SET body=? WHERE graph_id=? AND slot=?')
      .run(JSON.stringify(action), id, action.slot);
  }
}
