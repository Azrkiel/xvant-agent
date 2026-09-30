import { DomainError } from '../../contracts/src/index.ts';
import type { Task } from '../../contracts/src/index.ts';
import {
  handoffInputSchema,
  handoffSchema,
} from '../../contracts/src/handoff.ts';
import type { Handoff, HandoffInput } from '../../contracts/src/handoff.ts';
import type {
  ContextItem,
  ContextPacket,
  ContextPacketInput,
} from '../../contracts/src/context.ts';
import {
  buildContextPacket,
  canonicalJson,
  deepFreeze,
  sha256,
} from './packet.ts';

/**
 * Seal a handoff from the task's current attempt. The objective, criteria and
 * work revision come from the controller's task record, so a worker cannot
 * restate the requirements it hands on.
 */
export function createHandoff(
  task: Task,
  input: HandoffInput,
  now: number,
): Handoff {
  const parsed = handoffInputSchema.safeParse(input);
  if (!parsed.success || !Number.isSafeInteger(now) || now < 0)
    throw new DomainError('INVALID_INPUT', 'Invalid handoff');
  if (task.attemptId === undefined || task.attemptId !== parsed.data.attemptId)
    throw new DomainError(
      'STALE_EVIDENCE',
      'Only the current attempt can hand off',
    );
  const body = {
    ...parsed.data,
    version: 1 as const,
    projectId: task.projectId,
    taskId: task.id,
    workRevision: task.workRevision,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    createdAt: now,
  };
  return deepFreeze({ ...body, handoffHash: sha256(canonicalJson(body)) });
}

/** Recompute a received handoff's seal. Returns its hash or throws INVALID_EVIDENCE. */
export function verifyHandoff(value: unknown): string {
  const result = handoffSchema.safeParse(value);
  if (!result.success)
    throw new DomainError('INVALID_EVIDENCE', 'Malformed handoff');
  const { handoffHash, ...body } = result.data;
  if (sha256(canonicalJson(body)) !== handoffHash)
    throw new DomainError('INVALID_EVIDENCE', 'Handoff seal mismatch');
  return handoffHash;
}
const list = (title: string, entries: readonly string[]) =>
  entries.length
    ? '\n' + title + ':\n' + entries.map((entry) => '- ' + entry).join('\n')
    : '';
function handoffItems(handoff: Handoff): ContextItem[] {
  const item = (
    id: string,
    kind: ContextItem['kind'],
    part: string,
    content: string,
  ): ContextItem => ({
    id: 'ho_' + id,
    kind,
    required: true,
    priority: 100,
    content,
    provenance: {
      source: 'handoff',
      projectId: handoff.projectId,
      ref: 'handoff:' + handoff.id + '#' + part,
      contentHash: sha256(content),
      revision: handoff.baseRevision,
    },
  });
  return [
    item(
      'summary',
      'handoff',
      'summary',
      'Handoff from ' +
        handoff.fromWorkerId +
        ' (attempt ' +
        handoff.attemptId +
        '):\n' +
        handoff.summary +
        list('Completed', handoff.completed) +
        list('Remaining', handoff.remaining),
    ),
    ...handoff.failedAttempts.map((failure, index) =>
      item(
        'failure_' + (index + 1),
        'failure',
        'failure-' + (index + 1),
        'Attempt ' +
          failure.attemptId +
          ' ended ' +
          failure.reason +
          ': ' +
          failure.summary,
      ),
    ),
    ...handoff.openQuestions.map((question, index) =>
      item(
        'question_' + (index + 1),
        'question',
        'question-' + (index + 1),
        question,
      ),
    ),
    ...handoff.artifacts.map((artifact, index) =>
      item(
        'artifact_' + (index + 1),
        'artifact',
        'artifact-' + (index + 1),
        'Artifact ' +
          artifact.hash +
          ' (' +
          artifact.mediaType +
          '): ' +
          artifact.description,
      ),
    ),
  ];
}

/**
 * Build the named recipient's packet. Every handoff fact is a required item,
 * so an undersized budget fails instead of silently dropping continuation
 * evidence. Additional items (files, memory) stay optional.
 */
export function handoffPacket(
  handoff: Handoff,
  options: Pick<
    ContextPacketInput,
    'recipient' | 'ownership' | 'policy' | 'skills' | 'budget' | 'items'
  >,
): ContextPacket {
  verifyHandoff(handoff);
  if (options.recipient.workerId !== handoff.toWorkerId)
    throw new DomainError(
      'INVALID_INPUT',
      'Packet recipient differs from the handoff recipient',
    );
  return buildContextPacket({
    projectId: handoff.projectId,
    taskId: handoff.taskId,
    objective: handoff.objective,
    acceptanceCriteria: handoff.acceptanceCriteria,
    baseRevision: handoff.baseRevision,
    ...(handoff.workspaceTreeHash
      ? { workspaceTreeHash: handoff.workspaceTreeHash }
      : {}),
    ...options,
    items: [...handoffItems(handoff), ...options.items],
  });
}
