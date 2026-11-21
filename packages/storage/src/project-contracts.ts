import type Database from 'better-sqlite3';
import { z } from 'zod';
import { DomainError, idSchema, parse } from '../../contracts/src/index.ts';
import {
  backlogRevision,
  projectBacklogSchema,
  type ProjectBacklog,
} from '../../contracts/src/project-backlog.ts';
import { validateGraph } from '../../core/src/graph.ts';
import {
  acceptContractSchema,
  completionObservationSchema,
  projectContractSchema,
  projectPolicySchema,
  projectTaskSchema,
  type AcceptContract,
  type CompletionObservation,
  type ProjectContract,
  type ProjectPolicy,
  type ProjectTask,
} from '../../contracts/src/project.ts';
import {
  admitProjectTask,
  decideCompletion,
  validateProject,
  validateProjectPolicy,
  type CompletionDecision,
  type DeliveryAuthority,
} from '../../policy/src/project.ts';

export const projectContractsMigration = `
CREATE TABLE contract_projects(project_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,version));
CREATE TABLE contract_policies(project_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id,version));
CREATE TABLE contract_tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE contract_attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES contract_tasks(id));
`;

export const projectBacklogMigration = `
CREATE TABLE contract_backlogs(
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  project_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(project_id,revision),
  FOREIGN KEY(project_id,project_version) REFERENCES contract_projects(project_id,version),
  FOREIGN KEY(project_id,policy_version) REFERENCES contract_policies(project_id,version)
);
`;

const command = { commandId: idSchema };
const version = z.number().int().nonnegative();
export const projectCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...command,
    kind: z.literal('project'),
    expectedVersion: version,
    project: projectContractSchema,
  }),
  z.strictObject({
    ...command,
    kind: z.literal('policy'),
    expectedVersion: version,
    policy: projectPolicySchema,
  }),
  z.strictObject({
    ...command,
    kind: z.literal('task'),
    task: projectTaskSchema,
  }),
  z.strictObject({
    ...command,
    kind: z.literal('backlog'),
    expectedRevision: version,
    backlog: projectBacklogSchema,
  }),
  z.strictObject({
    ...command,
    kind: z.literal('accept'),
    taskId: idSchema,
    acceptance: acceptContractSchema,
  }),
]);

type Acceptance = {
  commandId: string;
  request: AcceptContract;
  accepted: boolean;
  decision: CompletionDecision;
};
export interface ContractTaskRecord {
  task: ProjectTask;
  rowVersion: number;
  attemptsRecorded: number;
  observation: CompletionObservation | null;
  evaluation: CompletionDecision | null;
  acceptance: Acceptance | null;
}

interface Host {
  command: <T>(
    project: string,
    kind: string,
    key: string,
    input: unknown,
    fn: () => T,
  ) => T;
  snapshot: <T>(fn: () => T) => T;
}

function fail(
  code: 'CONFLICT' | 'NOT_FOUND' | 'DUPLICATE_IDENTITY' | 'POLICY_DENIED',
  reason: string,
): never {
  throw new DomainError(code, reason);
}

export class ProjectContracts {
  readonly #db: Database.Database;
  readonly #host: Host;
  constructor(db: Database.Database, host: Host) {
    this.#db = db;
    this.#host = host;
  }

  #latest<T>(
    table: 'contract_projects' | 'contract_policies',
    id: string,
  ): T | null {
    const row = this.#db
      .prepare(
        `SELECT body FROM ${table} WHERE project_id=? ORDER BY version DESC LIMIT 1`,
      )
      .get(parse(idSchema, id)) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : null;
  }

  #project(id: string) {
    return (
      this.#latest<ProjectContract>('contract_projects', id) ??
      fail('NOT_FOUND', 'Project contract not found')
    );
  }

  getProject(id: string) {
    return this.#host.snapshot(() => ({
      project: this.#project(id),
      policy: this.#latest<ProjectPolicy>('contract_policies', id),
    }));
  }

  #backlog(id: string, revision?: number): ProjectBacklog | null {
    const row = (
      revision === undefined
        ? this.#db
            .prepare(
              'SELECT body FROM contract_backlogs WHERE project_id=? ORDER BY revision DESC LIMIT 1',
            )
            .get(id)
        : this.#db
            .prepare(
              'SELECT body FROM contract_backlogs WHERE project_id=? AND revision=?',
            )
            .get(id, parse(backlogRevision, revision))
    ) as { body: string } | undefined;
    return row ? projectBacklogSchema.parse(JSON.parse(row.body)) : null;
  }

  getBacklog(id: string, revision?: number) {
    return this.#host.snapshot(() => {
      const { project, policy } = this.getProject(id);
      const latest = this.#backlog(id);
      const backlog =
        revision === undefined || revision === latest?.revision
          ? latest
          : this.#backlog(id, revision);
      if (revision !== undefined && !backlog)
        fail('NOT_FOUND', 'Backlog revision not found');
      let status = 'unplanned';
      if (backlog) {
        if (backlog.revision !== latest?.revision) status = 'superseded';
        else if (
          backlog.projectVersion !== project.version ||
          backlog.policyVersion !== policy?.version
        )
          status = 'stale';
        else status = 'current';
      }
      return {
        projectId: project.id,
        projectVersion: project.version,
        ownerIntent: project.ownerIntent,
        requirements: project.requirements,
        policyVersion: policy?.version ?? null,
        budgetCeilings:
          policy?.projectVersion === project.version
            ? policy.authority.budget
            : null,
        backlog,
        status,
      };
    });
  }

  #saveBacklog(backlog: ProjectBacklog, expectedRevision: number) {
    const { projectId } = backlog;
    const { project, policy } = this.getProject(projectId);
    if (
      (this.#backlog(projectId)?.revision ?? 0) !== expectedRevision ||
      backlog.revision !== expectedRevision + 1
    )
      fail('CONFLICT', 'Backlog revision has changed');
    if (
      !policy ||
      policy.projectVersion !== project.version ||
      backlog.projectVersion !== project.version ||
      backlog.policyVersion !== policy.version
    )
      fail(
        'POLICY_DENIED',
        'Backlog requires current project and policy versions',
      );
    const order = validateGraph(
      backlog.milestones.map(({ id, dependsOn }) => ({ id, dependsOn })),
    );
    const requirements = new Set(project.requirements.map(({ id }) => id));
    for (const { requirementIds } of backlog.milestones) {
      if (
        new Set(requirementIds).size !== requirementIds.length ||
        requirementIds.some((id) => !requirements.has(id))
      )
        fail(
          'POLICY_DENIED',
          'Milestone requires distinct authorized requirement IDs',
        );
    }
    if (
      new Set(backlog.notes.map(({ id }) => id)).size !==
        backlog.notes.length ||
      backlog.notes.some(
        ({ milestoneId }) => milestoneId && !order.includes(milestoneId),
      )
    )
      fail(
        'CONFLICT',
        'Backlog notes require distinct IDs and known milestones',
      );
    this.#db
      .prepare('INSERT INTO contract_backlogs VALUES(?,?,?,?,?)')
      .run(
        projectId,
        backlog.revision,
        backlog.projectVersion,
        backlog.policyVersion,
        JSON.stringify(backlog),
      );
    return backlog;
  }

  #task(id: string): ContractTaskRecord {
    const row = this.#db
      .prepare('SELECT body FROM contract_tasks WHERE id=?')
      .get(parse(idSchema, id)) as { body: string } | undefined;
    if (!row) fail('NOT_FOUND', 'Task contract not found');
    return JSON.parse(row.body) as ContractTaskRecord;
  }

  #evaluate(record: ContractTaskRecord) {
    const { project, policy } = this.getProject(record.task.projectId);
    if (!policy) fail('NOT_FOUND', 'Project policy not found');
    return {
      policy,
      decision: decideCompletion(
        project,
        policy,
        record.task,
        record.observation ?? undefined,
      ),
    };
  }

  getTask(id: string) {
    return this.#host.snapshot(() => {
      const record = this.#task(id);
      const { decision } = this.#evaluate(record);
      const delivery: DeliveryAuthority = {
        localCandidate:
          record.task.authority.delivery.localCandidate &&
          !decision.blockers.includes('authorization_stale'),
        createPr: false,
        merge: false,
      };
      if (record.acceptance?.accepted && decision.readyForHumanReview) {
        delivery.createPr = record.task.authority.delivery.createPr;
        delivery.merge = record.task.authority.delivery.merge;
      }
      return { record, decision, delivery };
    });
  }

  apply(value: unknown) {
    const input = projectCommandSchema.parse(value);
    switch (input.kind) {
      case 'backlog':
        return this.#host.command(
          input.backlog.projectId,
          'contract.backlog',
          input.commandId,
          input,
          () => this.#saveBacklog(input.backlog, input.expectedRevision),
        );
      case 'project': {
        const { project, expectedVersion, commandId } = input;
        return this.#host.command(
          project.id,
          'contract.project',
          commandId,
          input,
          () => {
            const previous = this.#latest<ProjectContract>(
              'contract_projects',
              project.id,
            );
            if (
              (previous?.version ?? 0) !== expectedVersion ||
              project.version !== expectedVersion + 1
            )
              fail('CONFLICT', 'Project version has changed');
            if (
              previous &&
              previous.ownerIntent.actorId !== project.ownerIntent.actorId
            )
              fail('POLICY_DENIED', 'Project owner identity is immutable');
            validateProject(project);
            this.#db
              .prepare('INSERT INTO contract_projects VALUES(?,?,?)')
              .run(project.id, project.version, JSON.stringify(project));
            return project;
          },
        );
      }
      case 'policy': {
        const { policy, expectedVersion, commandId } = input;
        return this.#host.command(
          policy.projectId,
          'contract.policy',
          commandId,
          input,
          () => {
            const previous = this.#latest<ProjectPolicy>(
              'contract_policies',
              policy.projectId,
            );
            if (
              (previous?.version ?? 0) !== expectedVersion ||
              policy.version !== expectedVersion + 1
            )
              fail('CONFLICT', 'Policy version has changed');
            validateProjectPolicy(this.#project(policy.projectId), policy);
            this.#db
              .prepare('INSERT INTO contract_policies VALUES(?,?,?)')
              .run(policy.projectId, policy.version, JSON.stringify(policy));
            return policy;
          },
        );
      }
      case 'task': {
        const { task, commandId } = input;
        return this.#host.command(
          task.projectId,
          'contract.task',
          commandId,
          input,
          () => {
            const { project, policy } = this.getProject(task.projectId);
            if (!policy) fail('NOT_FOUND', 'Project policy not found');
            const parent = task.parentTaskId
              ? this.#task(task.parentTaskId).task
              : undefined;
            admitProjectTask(project, policy, task, parent);
            if (task.type === 'ship' && task.sourceReport) {
              const source = this.#task(task.sourceReport.taskId);
              if (
                source.task.projectId !== task.projectId ||
                source.task.type !== 'scout' ||
                !source.acceptance?.accepted ||
                source.observation?.outcome.status !== 'report' ||
                source.observation.outcome.revision !==
                  task.sourceReport.revision
              )
                fail(
                  'POLICY_DENIED',
                  'A linked ship task requires the exact accepted scout report',
                );
            }
            const record: ContractTaskRecord = {
              task,
              rowVersion: 1,
              attemptsRecorded: 0,
              observation: null,
              evaluation: null,
              acceptance: null,
            };
            if (
              !this.#db
                .prepare('INSERT OR IGNORE INTO contract_tasks VALUES(?,?,?)')
                .run(task.id, task.projectId, JSON.stringify(record)).changes
            )
              fail('DUPLICATE_IDENTITY', 'Task identity is already in use');
            return record;
          },
        );
      }
      case 'accept':
        return this.#accept(input.commandId, input.taskId, input.acceptance);
    }
  }

  #replace(record: ContractTaskRecord): ContractTaskRecord {
    const next = { ...record, rowVersion: record.rowVersion + 1 };
    this.#db
      .prepare('UPDATE contract_tasks SET body=? WHERE id=?')
      .run(JSON.stringify(next), record.task.id);
    return next;
  }

  #atVersion(id: string, expectedVersion: number): ContractTaskRecord {
    const record = this.#task(id);
    if (record.rowVersion !== expectedVersion || record.acceptance?.accepted)
      fail('CONFLICT', 'Task version has changed or is already accepted');
    return record;
  }

  /** Trusted host boundary. Never dispatch this method with client or model JSON. */
  recordObservation(
    commandId: string,
    id: string,
    expectedVersion: number,
    value: CompletionObservation,
  ): ContractTaskRecord {
    const observation = completionObservationSchema.parse(value);
    const project = this.#task(id).task.projectId;
    return this.#host.command(
      project,
      'contract.observe',
      commandId,
      { id, expectedVersion, observation },
      () => {
        const record = this.#atVersion(id, expectedVersion);
        if (record.observation?.outcome.status === 'unknown')
          fail(
            'CONFLICT',
            'The previous outcome must be reconciled before another attempt',
          );
        const attempt = this.#db
          .prepare('INSERT OR IGNORE INTO contract_attempts VALUES(?,?)')
          .run(observation.attemptId, id);
        if (!attempt.changes)
          fail('DUPLICATE_IDENTITY', 'Attempt identity is already in use');
        if (record.attemptsRecorded >= record.task.authority.budget.attempts)
          fail('POLICY_DENIED', 'Task attempt budget exhausted');
        const next = {
          ...record,
          attemptsRecorded: record.attemptsRecorded + 1,
          observation,
          acceptance: null,
        };
        const { decision } = this.#evaluate(next);
        return this.#replace({ ...next, evaluation: decision });
      },
    );
  }

  #accept(
    commandId: string,
    id: string,
    request: AcceptContract,
  ): ContractTaskRecord {
    const project = this.#task(id).task.projectId;
    return this.#host.command(
      project,
      'contract.accept',
      commandId,
      { id, request },
      () => {
        const record = this.#atVersion(id, request.expectedVersion);
        const observation = record.observation;
        if (
          !observation ||
          observation.attemptId !== request.attemptId ||
          !('revision' in observation.outcome) ||
          observation.outcome.revision !== request.revision
        )
          fail('CONFLICT', 'Acceptance must name the exact observed result');
        const { policy, decision } = this.#evaluate(record);
        const mode = request.mode;
        if (mode.kind !== 'automatic' && mode.actorId !== policy.ownerId)
          fail('POLICY_DENIED', 'Only the project owner may manually accept');
        let accepted = decision.eligibleForAutomaticAcceptance;
        if (mode.kind === 'manual')
          accepted =
            decision.readyForHumanReview &&
            decision.checks === 'passed' &&
            decision.review !== 'blocked';
        if (mode.kind === 'exception')
          accepted =
            decision.readyForHumanReview &&
            policy.escalation.allowManualException;
        return this.#replace({
          ...record,
          acceptance: { commandId, request, accepted, decision },
        });
      },
    );
  }
}
