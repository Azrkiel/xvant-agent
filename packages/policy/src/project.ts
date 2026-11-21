import { createHash } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.ts';
import type {
  CompletionObservation,
  CompletionSubject,
  ProjectContract,
  ProjectPolicy,
  ProjectTask,
  SourcedReport,
} from '../../contracts/src/project.ts';

type Authority = ProjectPolicy['authority'];
type Scope = ProjectContract['scope'];
export type DeliveryAuthority = Authority['delivery'];
const contains = (prefix: string, path: string) =>
  prefix === '.' || path === prefix || path.startsWith(prefix + '/');
const excludes = (prefix: string, path: string) =>
  contains(prefix.toLowerCase(), path.toLowerCase());
const subset = <T>(part: readonly T[], whole: readonly T[]) =>
  part.every((item) => whole.includes(item));

export function withinScope(scope: Scope, path: string): boolean {
  return (
    scope.paths.some((prefix) => contains(prefix, path)) &&
    !scope.excludedPaths.some((prefix) => excludes(prefix, path))
  );
}

function narrowScope(child: Scope, parent: Scope): boolean {
  return (
    child.repository === parent.repository &&
    child.paths.every(
      (path) =>
        parent.paths.some((prefix) => contains(prefix, path)) &&
        !parent.excludedPaths.some((prefix) => excludes(prefix, path)) &&
        parent.excludedPaths.every(
          (excluded) =>
            !excludes(path, excluded) ||
            child.excludedPaths.some((prefix) => excludes(prefix, excluded)),
        ),
    )
  );
}

function consistentScope(scope: Scope): boolean {
  return scope.paths.every((path) => withinScope(scope, path));
}

function narrowAuthority(child: Authority, parent: Authority): boolean {
  return (
    narrowScope(child.scope, parent.scope) &&
    subset(child.actions, parent.actions) &&
    subset(child.providers, parent.providers) &&
    child.budget.attempts <= parent.budget.attempts &&
    child.budget.wallTimeMs <= parent.budget.wallTimeMs &&
    child.budget.tokens <= parent.budget.tokens &&
    child.budget.costMicros <= parent.budget.costMicros &&
    (!child.delivery.localCandidate || parent.delivery.localCandidate) &&
    (!child.delivery.createPr || parent.delivery.createPr) &&
    (!child.delivery.merge || parent.delivery.merge)
  );
}

function consistentAuthority({ actions, scope, delivery }: Authority): boolean {
  return (
    consistentScope(scope) &&
    (!delivery.localCandidate || actions.includes('edit')) &&
    (!(delivery.createPr || delivery.merge) || delivery.localCandidate)
  );
}

function requirePolicy(condition: boolean, reason: string): void {
  if (!condition) throw new DomainError('POLICY_DENIED', reason);
}

export function validateProject(project: ProjectContract): void {
  requirePolicy(consistentScope(project.scope), 'Contradictory project scope');
}

export function validateProjectPolicy(
  project: ProjectContract,
  policy: ProjectPolicy,
): void {
  requirePolicy(
    policy.projectId === project.id &&
      policy.projectVersion === project.version &&
      policy.ownerId === project.ownerIntent.actorId,
    'Policy must refer to the current owner and project version',
  );
  requirePolicy(
    consistentAuthority(policy.authority) &&
      narrowScope(policy.authority.scope, project.scope),
    'Policy authority contradicts or exceeds project scope',
  );
  const ids = project.requirements.map(({ id }) => id);
  requirePolicy(
    policy.verifier.checks.every((check) => subset(check.requirementIds, ids)),
    'Verifier references an unknown requirement',
  );
}

export function admitProjectTask(
  project: ProjectContract,
  policy: ProjectPolicy,
  task: ProjectTask,
  parent?: ProjectTask,
): void {
  requirePolicy(
    task.projectId === project.id &&
      policy.projectId === project.id &&
      policy.ownerId === project.ownerIntent.actorId &&
      task.projectVersion === project.version &&
      policy.projectVersion === project.version &&
      task.policyVersion === policy.version &&
      task.ownerIntent.actorId === project.ownerIntent.actorId,
    'Task must refer to the current owner, project and policy',
  );
  requirePolicy(
    consistentAuthority(task.authority) &&
      narrowAuthority(task.authority, policy.authority) &&
      subset(
        task.requirementIds,
        project.requirements.map(({ id }) => id),
      ),
    'Task authority contradicts or exceeds policy',
  );
  const { actions, delivery } = task.authority;
  requirePolicy(
    actions.includes('read') &&
      (task.type === 'scout'
        ? actions.includes('report') &&
          !actions.includes('edit') &&
          !delivery.localCandidate
        : delivery.localCandidate),
    'Task type and delivery authority disagree',
  );
  if (task.parentTaskId) {
    requirePolicy(
      !!parent &&
        task.parentTaskId === parent.id &&
        parent.projectId === task.projectId &&
        parent.projectVersion === task.projectVersion &&
        parent.policyVersion === task.policyVersion &&
        parent.baseRevision === task.baseRevision &&
        subset(task.requirementIds, parent.requirementIds) &&
        narrowAuthority(task.authority, parent.authority),
      'Child task authority exceeds or outlives parent authority',
    );
  }
}

export type CompletionBlocker =
  | 'authorization_stale'
  | 'no_result'
  | 'unknown'
  | 'failed'
  | 'scope_violation'
  | 'provider_violation'
  | 'invalid_report'
  | 'invalid_candidate'
  | 'checks_missing'
  | 'verification_stale'
  | 'checks_not_passed'
  | 'review_missing'
  | 'review_stale'
  | 'reviewer_ineligible'
  | 'review_rejected'
  | 'review_unknown'
  | 'automatic_acceptance_disabled';

export type CompletionDecision = {
  subject: CompletionSubject | null;
  evaluatedAgainst: {
    projectVersion: number;
    policyVersion: number;
    verifierId: string;
    verifierConfigHash: string;
  };
  readyForHumanReview: boolean;
  eligibleForAutomaticAcceptance: boolean;
  checks: 'passed' | 'blocked' | 'unavailable';
  review: 'approved' | 'blocked' | 'not_required' | 'unavailable';
  blockers: CompletionBlocker[];
};

export function reportRevision(
  repository: string,
  baseRevision: string,
  report: SourcedReport,
): string {
  return createHash('sha256')
    .update(JSON.stringify([repository, baseRevision, report]))
    .digest('hex');
}

export function completionSubject(
  task: ProjectTask,
  policy: ProjectPolicy,
  attemptId: string,
  revision: string,
): CompletionSubject {
  return {
    projectId: task.projectId,
    projectVersion: task.projectVersion,
    policyVersion: task.policyVersion,
    taskId: task.id,
    attemptId,
    baseRevision: task.baseRevision,
    revision,
    requirementIds: [...task.requirementIds].sort(),
    verifierId: policy.verifier.id,
    verifierConfigHash: policy.verifier.configHash,
  };
}

function sameSubject(
  expected: CompletionSubject,
  actual: CompletionSubject,
): boolean {
  return (
    expected.projectId === actual.projectId &&
    expected.projectVersion === actual.projectVersion &&
    expected.policyVersion === actual.policyVersion &&
    expected.taskId === actual.taskId &&
    expected.attemptId === actual.attemptId &&
    expected.baseRevision === actual.baseRevision &&
    expected.revision === actual.revision &&
    expected.verifierId === actual.verifierId &&
    expected.verifierConfigHash === actual.verifierConfigHash &&
    expected.requirementIds.length === actual.requirementIds.length &&
    subset(expected.requirementIds, actual.requirementIds)
  );
}

/** Pure evaluation of facts observed by the host. Worker claims are not evidence. */
export function decideCompletion(
  project: ProjectContract,
  policy: ProjectPolicy,
  task: ProjectTask,
  observation?: CompletionObservation,
): CompletionDecision {
  const evaluatedAgainst = {
    projectVersion: project.version,
    policyVersion: policy.version,
    verifierId: policy.verifier.id,
    verifierConfigHash: policy.verifier.configHash,
  };
  const blocked = (reason: CompletionBlocker): CompletionDecision => ({
    subject: null,
    evaluatedAgainst,
    readyForHumanReview: false,
    eligibleForAutomaticAcceptance: false,
    checks: 'unavailable',
    review: 'unavailable',
    blockers: [reason],
  });
  if (
    task.projectId !== project.id ||
    policy.projectId !== project.id ||
    task.projectVersion !== project.version ||
    task.policyVersion !== policy.version ||
    policy.projectVersion !== project.version
  )
    return blocked('authorization_stale');
  const outcome = observation?.outcome;
  if (!outcome || outcome.status === 'unknown' || outcome.status === 'failed')
    return blocked(outcome?.status ?? 'no_result');
  if (
    outcome.repository !== task.authority.scope.repository ||
    outcome.baseRevision !== task.baseRevision ||
    outcome.changedPaths.some(
      (path) => !withinScope(task.authority.scope, path),
    )
  )
    return blocked('scope_violation');
  if (!task.authority.providers.includes(outcome.provider))
    return blocked('provider_violation');
  if (task.type === 'scout') {
    if (
      outcome.status !== 'report' ||
      outcome.revision !==
        reportRevision(
          outcome.repository,
          outcome.baseRevision,
          outcome.report,
        ) ||
      outcome.changedPaths.length > 0 ||
      outcome.report.sources.some(
        ({ path, revision }) =>
          revision !== outcome.baseRevision ||
          !withinScope(task.authority.scope, path),
      )
    )
      return blocked('invalid_report');
  } else if (
    outcome.status !== 'candidate' ||
    outcome.changedPaths.length === 0 ||
    outcome.baseRevision === outcome.revision
  ) {
    return blocked('invalid_candidate');
  }
  const subject = completionSubject(
    task,
    policy,
    observation.attemptId,
    outcome.revision,
  );
  const blockers: CompletionBlocker[] = [];
  const required = policy.verifier.checks.filter(({ requirementIds }) =>
    requirementIds.some((id) => task.requirementIds.includes(id)),
  );
  const verification = observation.verification;
  if (
    !subset(
      task.requirementIds,
      required.flatMap((check) => check.requirementIds),
    ) ||
    !verification ||
    verification.checks.length === 0
  ) {
    blockers.push('checks_missing');
  } else if (!sameSubject(subject, verification.subject)) {
    blockers.push('verification_stale');
  } else if (
    required.some(
      ({ id }) => !verification.checks.some((check) => check.id === id),
    )
  ) {
    blockers.push('checks_missing');
  } else if (
    required.some(
      ({ id }) =>
        verification.checks.find((check) => check.id === id)?.status !==
        'passed',
    )
  ) {
    blockers.push('checks_not_passed');
  }
  const checks = blockers.length === 0 ? 'passed' : 'blocked';
  const review = observation.review;
  const reviewRule = policy.review;
  let reviewBlocker: CompletionBlocker | undefined;
  if (reviewRule.required) {
    if (!review) reviewBlocker = 'review_missing';
    else if (!sameSubject(subject, review.subject))
      reviewBlocker = 'review_stale';
    else if (
      !reviewRule.reviewers.includes(review.reviewerId) ||
      outcome.producers.includes(review.reviewerId)
    )
      reviewBlocker = 'reviewer_ineligible';
    else if (review.status !== 'approved')
      reviewBlocker = `review_${review.status}`;
  }
  if (reviewBlocker) blockers.push(reviewBlocker);
  if (!policy.automaticAcceptance)
    blockers.push('automatic_acceptance_disabled');
  return {
    subject,
    evaluatedAgainst,
    readyForHumanReview: true,
    eligibleForAutomaticAcceptance: blockers.length === 0,
    checks,
    review: reviewBlocker
      ? 'blocked'
      : reviewRule.required
        ? 'approved'
        : 'not_required',
    blockers,
  };
}
