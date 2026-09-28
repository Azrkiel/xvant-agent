import { taskSchema, type Task } from '../../contracts/src/index.ts';
import {
  nativeEvidenceSchema,
  type NativeEvidence,
} from '../../contracts/src/native-evidence.ts';

/** Pure consistency policy. Store owns receipt provenance and explicit approval audit. */
export function nativeAcceptanceTask(
  input: Task,
  target: 'ready_for_acceptance' | 'accepted',
  value: NativeEvidence,
): Task {
  const task = taskSchema.parse(input);
  const evidence = nativeEvidenceSchema.parse(value);
  if (
    task.state !==
    (target === 'accepted' ? 'ready_for_acceptance' : 'verifying')
  )
    throw new Error('ILLEGAL_TRANSITION');
  if (
    evidence.taskId !== task.id ||
    evidence.attemptId !== task.attemptId ||
    evidence.workRevision !== task.workRevision ||
    evidence.treeHash !== task.treeHash ||
    evidence.artifactSetHash !== task.artifactSetHash
  )
    throw new Error('STALE_EVIDENCE');
  if (
    evidence.receipts.length !== task.requiredCheckIds.length ||
    evidence.receipts.some(
      (receipt) =>
        !task.requiredCheckIds.includes(receipt.checkId) ||
        receipt.status !== 'passed',
    )
  )
    throw new Error('CHECK_FAILED');
  const qualification = {
    connectionId: evidence.connectionId,
    runtimeKind: evidence.runtimeKind,
    classification: evidence.classification,
  };
  if (
    target === 'accepted' &&
    (!task.nativeQualification ||
      task.nativeQualification.connectionId !== qualification.connectionId ||
      task.nativeQualification.runtimeKind !== qualification.runtimeKind ||
      task.nativeQualification.classification !== qualification.classification)
  )
    throw new Error('STALE_EVIDENCE');
  return {
    ...task,
    state: target,
    rowVersion: task.rowVersion + 1,
    nativeQualification: qualification,
  };
}
