import {
  DomainError,
  parse,
  createTaskSchema,
  taskSchema,
  evidenceSchema,
  workInputSchema,
  attemptSchema,
} from '../../contracts/src/index.ts';
import type {
  Task,
  TaskState,
  Evidence,
  CreateTask,
  Attempt,
  AttemptState,
} from '../../contracts/src/index.ts';

const taskTransitions: Record<TaskState, readonly TaskState[]> = {
  draft: ['queued', 'cancelling'],
  queued: ['running', 'blocked', 'paused', 'cancelling'],
  running: ['verifying', 'paused', 'needs_attention', 'cancelling'],
  verifying: [
    'ready_for_acceptance',
    'needs_rework',
    'needs_attention',
    'cancelling',
  ],
  ready_for_acceptance: ['accepted', 'needs_rework', 'cancelling'],
  accepted: [],
  blocked: ['queued', 'cancelling'],
  paused: ['queued', 'cancelling'],
  needs_rework: ['queued', 'cancelling'],
  needs_attention: ['queued', 'verifying', 'cancelling'],
  cancelling: ['cancelled', 'needs_attention'],
  cancelled: [],
};
const attemptTransitions: Record<AttemptState, readonly AttemptState[]> = {
  reserved: ['dispatching', 'cancelled'],
  dispatching: ['running', 'failed', 'cancelled', 'unknown'],
  running: ['interrupt_requested', 'succeeded', 'failed', 'unknown'],
  interrupt_requested: ['cancelled', 'succeeded', 'failed', 'unknown'],
  succeeded: [],
  failed: [],
  cancelled: [],
  unknown: [],
};
export function createTask(input: CreateTask): Task {
  return {
    ...parse(createTaskSchema, input),
    state: 'draft',
    workRevision: 0,
    rowVersion: 0,
  };
}
function verifyEvidence(task: Task, input: Evidence | undefined): void {
  if (!input)
    throw new DomainError(
      'EVIDENCE_REQUIRED',
      'Current verification receipts are required',
    );
  const evidence = parse(evidenceSchema, input);
  const matches = (value: Evidence | Evidence['receipts'][number]) =>
    value.taskId === task.id &&
    value.attemptId === task.attemptId &&
    value.workRevision === task.workRevision &&
    value.treeHash === task.treeHash &&
    value.artifactSetHash === task.artifactSetHash;
  if (!matches(evidence))
    throw new DomainError(
      'STALE_EVIDENCE',
      'Evidence does not describe the current work',
    );
  const receipts = new Map<string, Evidence['receipts'][number]>();
  for (const receipt of evidence.receipts) {
    if (
      receipts.has(receipt.checkId) ||
      !task.requiredCheckIds.includes(receipt.checkId)
    )
      throw new DomainError(
        'INVALID_EVIDENCE',
        'Duplicate or unexpected check receipt',
      );
    if (!matches(receipt))
      throw new DomainError(
        'STALE_EVIDENCE',
        'Check receipt describes different work',
      );
    receipts.set(receipt.checkId, receipt);
  }
  for (const check of task.requiredCheckIds) {
    const receipt = receipts.get(check);
    if (!receipt)
      throw new DomainError(
        'EVIDENCE_REQUIRED',
        'A required check has no receipt',
      );
    if (receipt.status !== 'passed')
      throw new DomainError('CHECK_FAILED', 'A required check failed');
  }
}
// These pure rules check evidence consistency. The controller owns receipt provenance.
export function transitionTask(
  input: Task,
  state: TaskState,
  evidence?: Evidence,
): Task {
  const task = parse(taskSchema, input);
  if (!taskTransitions[task.state].includes(state))
    throw new DomainError(
      'ILLEGAL_TRANSITION',
      'Task transition is not permitted',
    );
  if (state === 'ready_for_acceptance' || state === 'accepted')
    verifyEvidence(task, evidence);
  return { ...task, state, rowVersion: task.rowVersion + 1 };
}
export function reviseTask(input: Task, work: unknown): Task {
  const task = parse(taskSchema, input);
  if (
    !(
      [
        'draft',
        'queued',
        'blocked',
        'paused',
        'needs_rework',
        'needs_attention',
        'ready_for_acceptance',
      ] as TaskState[]
    ).includes(task.state)
  )
    throw new DomainError(
      'ILLEGAL_TRANSITION',
      'Cannot edit executing or terminal work',
    );
  const changes = parse(workInputSchema, work);
  const rest = { ...task };
  delete rest.attemptId;
  delete rest.treeHash;
  delete rest.artifactSetHash;
  // An edit starts a new work revision; state-only changes never invalidate receipts.
  return {
    ...rest,
    ...changes,
    state: task.state === 'draft' ? 'draft' : 'needs_rework',
    workRevision: task.workRevision + 1,
    rowVersion: task.rowVersion + 1,
  };
}
export function createAttempt(
  id: string,
  taskId: string,
  workerId: string,
): Attempt {
  return parse(attemptSchema, {
    id,
    taskId,
    workerId,
    state: 'reserved',
    rowVersion: 0,
  });
}
export function transitionAttempt(
  input: Attempt,
  state: AttemptState,
): Attempt {
  const attempt = parse(attemptSchema, input);
  if (!attemptTransitions[attempt.state].includes(state))
    throw new DomainError(
      'ILLEGAL_TRANSITION',
      'Attempt transition is not permitted',
    );
  return { ...attempt, state, rowVersion: attempt.rowVersion + 1 };
}
