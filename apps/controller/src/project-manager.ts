import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from '../../../packages/contracts/src/index.ts';
import { backlogRevision } from '../../../packages/contracts/src/project-backlog.ts';
import {
  admitProjectTask,
  completionSubject,
  withinScope,
} from '../../../packages/policy/src/project.ts';
import { resolveGitCommit } from '../../../packages/storage/src/git-workspace.ts';
import type { ManagerRun } from '../../../packages/storage/src/project-contracts.ts';
import type { Store } from '../../../packages/storage/src/store.ts';
import {
  assigneeSchema,
  planSchema,
  validatePlan,
} from '../../../packages/core/src/plan.ts';
import { HttpError } from './http/app-server.ts';
import {
  Orchestrator,
  type RootSpec,
  type RootState,
  type WorkerSpec,
} from './orchestrator.ts';
import {
  turnIntentSchema,
  verifierHash,
  type WorkflowCheckpoint,
} from './workflow-checkpoint.ts';

export const managerStartSchema = z.strictObject({
  commandId: idSchema,
  revision: backlogRevision,
  taskId: idSchema,
  lessons: z.boolean().optional(),
  maxActive: z.number().int().min(1).max(10).default(1),
  maxRepairs: z.number().int().min(0).max(1).default(1),
  milestones: z
    .array(
      z.strictObject({
        id: idSchema,
        paths: planSchema.shape.nodes.element.shape.writablePaths
          .unwrap()
          .min(1),
        assignee: assigneeSchema.optional(),
        tier: z.enum(['light', 'standard']).optional(),
      }),
    )
    .min(1)
    .max(20),
});

type ManagerInput = z.infer<typeof managerStartSchema>;
export type ManagerVerifier = {
  checks: WorkflowCheckpoint['spec']['checks'];
  checkTimeoutMs: number;
};

export function prepareManagerRun(
  store: Store,
  projectId: string,
  input: ManagerInput,
  verifier: ManagerVerifier | undefined,
  workers: WorkerSpec[],
): {
  spec: RootSpec;
  run: ManagerRun;
  turnTimeoutMs: number;
  pool: WorkerSpec[];
} {
  const { backlog, status } = store.contracts.getBacklog(projectId);
  const { project, policy } = store.contracts.getProject(projectId);
  if (
    status !== 'current' ||
    !backlog ||
    backlog.revision !== input.revision ||
    !policy
  )
    throw new HttpError(409, 'CURRENT_BACKLOG_REQUIRED');
  const { record } = store.contracts.getTask(input.taskId);
  const { task } = record;
  if (
    task.type !== 'ship' ||
    task.parentTaskId ||
    task.sourceReport ||
    task.projectId !== projectId ||
    record.attemptsRecorded ||
    !task.authority.actions.includes('verify')
  )
    throw new HttpError(409, 'UNUSED_SHIP_AUTHORITY_REQUIRED');
  admitProjectTask(project, policy, task);
  if (
    resolveGitCommit(task.authority.scope.repository, 'HEAD') !==
    task.baseRevision
  )
    throw new HttpError(409, 'MANAGER_BASE_MOVED');
  const config = verifier && { ...verifier, nodeChecks: [] };
  if (!config || verifierHash(config) !== policy.verifier.configHash)
    throw new HttpError(409, 'MANAGER_VERIFIER_UNAVAILABLE');
  const requirements = new Set(
    backlog.milestones.flatMap(({ requirementIds }) => requirementIds),
  );
  if (
    requirements.size !== task.requirementIds.length ||
    task.requirementIds.some((id) => !requirements.has(id)) ||
    project.requirements.some(({ id }) => !requirements.has(id))
  )
    throw new HttpError(409, 'MANAGER_REQUIREMENTS_MISMATCH');
  if (
    Object.keys(config.checks).length !== policy.verifier.checks.length ||
    policy.verifier.checks.some(
      ({ id }) => !Object.hasOwn(config.checks, id),
    ) ||
    [...requirements].some(
      (id) =>
        !policy.verifier.checks.some((check) =>
          check.requirementIds.includes(id),
        ),
    )
  )
    throw new HttpError(409, 'MANAGER_REQUIRED_CHECKS_MISSING');
  const pool = workers
    .filter(
      ({ runtimeKind }) =>
        runtimeKind !== 'native-local' &&
        task.authority.providers.includes(runtimeKind),
    )
    .map((worker) => ({
      ...worker,
      roles: worker.roles.filter(
        (role) =>
          role !== 'reviewer' ||
          (policy.review.required &&
            policy.review.reviewers.includes(worker.alias)),
      ),
    }));
  if (
    !pool.some((worker) => worker.roles.includes('worker')) ||
    (policy.review.required &&
      !pool.some((worker) => worker.roles.includes('reviewer')))
  )
    throw new HttpError(409, 'MANAGER_WORKERS_UNAVAILABLE');

  const choices = new Map(input.milestones.map((item) => [item.id, item]));
  if (
    choices.size !== backlog.milestones.length ||
    choices.size !== input.milestones.length
  )
    throw new HttpError(409, 'MANAGER_MILESTONES_MISMATCH');
  const criteria = new Map(
    project.requirements.map(({ id, description }) => [id, description]),
  );
  const { plan } = validatePlan({
    summary: backlog.reason,
    nodes: [...backlog.milestones]
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
      .map((milestone) => {
        const choice = choices.get(milestone.id);
        if (
          !choice ||
          choice.paths.some(
            (path) =>
              !withinScope(task.authority.scope, path) ||
              task.authority.scope.excludedPaths.some((excluded) =>
                excluded.toLowerCase().startsWith(path.toLowerCase() + '/'),
              ),
          )
        )
          throw new HttpError(409, 'MANAGER_SCOPE_DENIED');
        return {
          id: milestone.id,
          title: milestone.title.slice(0, 120),
          objective: milestone.title + '\n' + milestone.reason,
          acceptanceCriteria: milestone.requirementIds.map((id) =>
            criteria.get(id)!,
          ),
          dependsOn: milestone.dependsOn,
          ...(choice.assignee ? { assignee: choice.assignee } : {}),
          ...(choice.tier ? { tier: choice.tier } : {}),
          writablePaths: choice.paths,
        };
      }),
  });
  const attempts =
    plan.nodes.length * (1 + input.maxRepairs) +
    input.maxRepairs +
    Number(policy.review.required);
  const checks = policy.verifier.checks.length * (1 + input.maxRepairs);
  const { budget } = task.authority;
  const turnTimeoutMs = Math.min(
    3_600_000,
    Math.floor((budget.wallTimeMs - checks * config.checkTimeoutMs) / attempts),
  );
  if (attempts > budget.attempts || turnTimeoutMs < 1)
    throw new HttpError(409, 'MANAGER_BUDGET_EXHAUSTED');
  const id =
    'manager_' +
    createHash('sha256')
      .update(JSON.stringify([projectId, input.revision]))
      .digest('hex')
      .slice(0, 40);
  const run = {
    projectId,
    revision: input.revision,
    taskId: task.id,
    rootId: id,
    attempts,
    wallTimeMs: attempts * turnTimeoutMs + checks * config.checkTimeoutMs,
  };
  return {
    turnTimeoutMs,
    run,
    pool,
    spec: {
      id,
      projectId,
      repository: task.authority.scope.repository,
      baseRevision: task.baseRevision,
      objective: task.ownerIntent.objective,
      acceptanceCriteria: [...criteria.values()],
      checks: config.checks,
      checkTimeoutMs: config.checkTimeoutMs,
      plan,
      maxActive: input.maxActive,
      maxRepairs: input.maxRepairs,
      maxReviewRepairs: 0,
      review: policy.review.required,
      lessons: input.lessons ?? false,
      ...(input.lessons
        ? {
            lessonScope:
              'contract-' +
              createHash('sha256').update(projectId).digest('hex').slice(0, 32),
          }
        : {}),
    },
  };
}

export function observeManagerRun(
  store: Store,
  run: ManagerRun,
  state: RootState,
) {
  const { record } = store.contracts.getTask(run.taskId);
  if (record.observation) return;
  const { task } = record;
  const attemptId = run.rootId + '_result';
  const base = {
    commandId: attemptId,
    taskId: task.id,
    expectedVersion: record.rowVersion,
    attemptId,
  };
  const policy = store.contracts.getProject(task.projectId).policy;
  const checkpoint = Orchestrator.checkpoint(store, run.rootId);
  const { head } = state.integration ?? {};
  const producers = Object.keys(checkpoint.progress.completed).sort();
  const provider = checkpoint.workers.find(
    ({ alias }) => alias === producers[0],
  )?.runtimeKind;
  if (
    !policy ||
    !head ||
    state.phase !== 'ready' ||
    !provider ||
    provider === 'native-local'
  ) {
    Orchestrator.observeContractResult(store, {
      ...base,
      outcome: { status: 'failed' },
    });
    return;
  }
  const subject = completionSubject(task, policy, attemptId, head);
  const review = state.review;
  const reviewedHead =
    review &&
    store.workflows.actions(run.rootId).some((action) => {
      if (
        action.status !== 'completed' ||
        action.kind !== 'turn' ||
        action.slot !== 'review:0'
      )
        return false;
      const intent = turnIntentSchema.parse(action.input);
      return (
        intent.alias === review.alias && intent.workspace.baseCommit === head
      );
    });
  Orchestrator.observeContractResult(store, {
    ...base,
    outcome: { status: 'candidate', revision: head, producers, provider },
    verification: {
      subject,
      checks: state.checks
        .filter((check) => check.head === head)
        .map(({ id, status }) => ({ id, status })),
    },
    ...(review?.independent && reviewedHead
      ? {
          review: {
            subject,
            reviewerId: review.alias,
            status: review.approve ? 'approved' : 'rejected',
          },
        }
      : {}),
  });
}
