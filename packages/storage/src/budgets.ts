import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DomainError, idSchema } from '../../contracts/src/index.ts';
import type { ProjectTask } from '../../contracts/src/project.ts';
import { admitProjectTask } from '../../policy/src/project.ts';
import type { ProjectContracts } from './project-contracts.ts';

export const budgetMigration = `
CREATE TABLE budget_limits(id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE budget_reservations(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES contract_tasks(id),
  body TEXT NOT NULL
);
`;

const usageSchema = z.strictObject({
  wallTimeMs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costMicros: z.number().int().nonnegative(),
});
const budgetSchema = usageSchema.extend({
  attempts: z.number().int().positive(),
});
const reservationSchema = z.strictObject({
  id: idSchema,
  taskId: idSchema,
  projectId: idSchema,
  projectVersion: z.number().int().positive(),
  policyVersion: z.number().int().positive(),
  ancestors: z.array(idSchema).max(3),
  allocation: usageSchema,
  status: z.enum(['reserved', 'unknown', 'settled']),
  usage: usageSchema.nullable(),
});
type Budget = z.infer<typeof budgetSchema>;
type Usage = z.infer<typeof usageSchema>;
type Reservation = z.infer<typeof reservationSchema>;
const resources = ['wallTimeMs', 'tokens', 'costMicros'] as const;
const deny = (message: string): never => {
  throw new DomainError('POLICY_DENIED', message);
};

/** Cumulative project and task allocations. Unknown outcomes charge the entire reservation. */
export class Budgets {
  readonly #db: Database.Database;
  readonly #contracts: ProjectContracts;
  readonly #mutate: <T>(fn: () => T) => T;

  constructor(
    db: Database.Database,
    contracts: ProjectContracts,
    mutate: <T>(fn: () => T) => T,
  ) {
    this.#db = db;
    this.#contracts = contracts;
    this.#mutate = mutate;
  }

  configure(value: Budget): void {
    const body = JSON.stringify(budgetSchema.parse(value));
    this.#mutate(() => {
      this.#db
        .prepare("INSERT OR IGNORE INTO budget_limits VALUES('global',?)")
        .run(body);
      if (JSON.stringify(this.#limit()) !== body)
        deny('An initialized global budget cannot be replaced');
    });
  }

  #limit(): Budget {
    const row = this.#db
      .prepare("SELECT body FROM budget_limits WHERE id='global'")
      .get() as { body: string } | undefined;
    if (!row)
      return deny('Configure a global budget before reserving resources');
    return budgetSchema.parse(JSON.parse(row.body));
  }

  get(id: string): Reservation | null {
    const row = this.#db
      .prepare('SELECT body FROM budget_reservations WHERE id=?')
      .get(idSchema.parse(id)) as { body: string } | undefined;
    return row ? reservationSchema.parse(JSON.parse(row.body)) : null;
  }

  #check(limit: Budget, rows: Reservation[], allocation: Usage, scope: string) {
    if (rows.length >= limit.attempts)
      deny('Attempt budget exhausted for ' + scope);
    for (const key of resources) {
      let remaining = limit[key] - allocation[key];
      for (const row of rows) remaining -= (row.usage ?? row.allocation)[key];
      if (remaining < 0) deny('Insufficient ' + key + ' for ' + scope);
    }
  }

  reserve(id: string, taskId: string, value: Usage): Reservation {
    return this.#reserve(id, taskId, value, true);
  }

  /** A matching reservation after a crash is evidence to reconcile, never a new dispatch grant. */
  reserveForDispatch(id: string, taskId: string, value: Usage): Reservation {
    return this.#reserve(id, taskId, value, false);
  }

  #reserve(
    id: string,
    taskId: string,
    value: Usage,
    allowReplay: boolean,
  ): Reservation {
    idSchema.parse(id);
    idSchema.parse(taskId);
    const allocation = usageSchema.parse(value);
    if (allocation.wallTimeMs === 0)
      deny('A positive wall-time reservation is required');
    return this.#mutate(() => {
      const previous = this.get(id);
      if (previous) {
        if (
          previous.taskId !== taskId ||
          JSON.stringify(previous.allocation) !== JSON.stringify(allocation)
        )
          throw new DomainError(
            'CONFLICT',
            'Reservation ID is bound to another dispatch',
          );
        if (!allowReplay)
          throw new DomainError(
            'CONFLICT',
            'Dispatch has a prior reservation; reconcile it before continuing',
          );
        return previous;
      }
      const { record } = this.#contracts.getTask(taskId);
      const { task } = record;
      const { project, policy } = this.#contracts.getProject(task.projectId);
      if (
        !policy ||
        record.acceptance?.accepted ||
        record.observation?.outcome.status === 'unknown'
      )
        return deny(
          'Task requires current authority and a resolved previous outcome',
        );
      const ancestors: ProjectTask[] = [];
      let parentId = task.parentTaskId;
      while (parentId) {
        if (ancestors.length === 3)
          deny('Budget hierarchy exceeds three ancestors');
        const { record: parent } = this.#contracts.getTask(parentId);
        ancestors.push(parent.task);
        parentId = parent.task.parentTaskId;
      }
      admitProjectTask(project, policy, task, ancestors[0]);
      const rows = this.#db
        .prepare('SELECT body FROM budget_reservations')
        .all() as { body: string }[];
      const reservations = rows.map(({ body }) =>
        reservationSchema.parse(JSON.parse(body)),
      );
      const projectRows = reservations.filter(
        (row) => row.projectId === task.projectId,
      );
      this.#check(this.#limit(), reservations, allocation, 'global budget');
      this.#check(
        policy.authority.budget,
        projectRows,
        allocation,
        task.projectId,
      );
      for (const entry of [task, ...ancestors])
        this.#check(
          entry.authority.budget,
          projectRows.filter(
            (row) =>
              row.taskId === entry.id || row.ancestors.includes(entry.id),
          ),
          allocation,
          entry.id,
        );
      if (
        projectRows.some(
          (row) => row.taskId === taskId && row.status !== 'settled',
        )
      )
        deny('The task already has an active or unresolved reservation');
      const result: Reservation = {
        id,
        taskId,
        projectId: task.projectId,
        projectVersion: task.projectVersion,
        policyVersion: task.policyVersion,
        ancestors: ancestors.map(({ id }) => id),
        allocation,
        status: 'reserved',
        usage: null,
      };
      this.#db
        .prepare('INSERT INTO budget_reservations VALUES(?,?,?)')
        .run(id, taskId, JSON.stringify(result));
      return result;
    });
  }

  /** The caller supplies independently observed usage, or null when any dimension is unknown. */
  settle(id: string, value: Usage | null): Reservation {
    const usage = value === null ? null : usageSchema.parse(value);
    return this.#mutate(() => {
      const previous = this.get(id);
      if (!previous)
        throw new DomainError('NOT_FOUND', 'Budget reservation not found');
      if (previous.status === 'settled') {
        if (JSON.stringify(previous.usage) !== JSON.stringify(usage))
          throw new DomainError('CONFLICT', 'Settled usage is immutable');
        return previous;
      }
      // Record measured overruns too. They continue to count against future admissions.
      const next: Reservation = {
        ...previous,
        usage,
        status: usage === null ? 'unknown' : 'settled',
      };
      this.#db
        .prepare('UPDATE budget_reservations SET body=? WHERE id=?')
        .run(JSON.stringify(next), id);
      return next;
    });
  }
}
