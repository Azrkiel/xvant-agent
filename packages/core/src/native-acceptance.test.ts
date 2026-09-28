import { expect, it } from 'vitest';
import { createTask, reviseTask } from './task.ts';
import { nativeAcceptanceTask } from './native-acceptance.ts';
import type { NativeEvidence } from '../../contracts/src/native-evidence.ts';
const binding = {
  taskId: 'task',
  attemptId: 'attempt',
  connectionId: 'connection',
  workspaceId: 'workspace',
  workRevision: 0,
  generation: 1,
  hostId: 'host',
  runtimeKind: 'codex' as const,
  classification: 'offline' as const,
  nativeSessionId: 'thread:1',
  nativeRunId: 'turn:1',
  treeHash: 'a'.repeat(64),
  artifactSetHash: 'b'.repeat(64),
  workspaceRootHash: 'c'.repeat(64),
};
const evidence: NativeEvidence = {
  ...binding,
  receipts: [
    {
      ...binding,
      checkId: 'test',
      commandHash: 'd'.repeat(64),
      status: 'passed',
    },
  ],
};
const task = {
  ...createTask({
    id: 'task',
    projectId: 'project',
    objective: 'Fixture',
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Pass'],
  }),
  state: 'verifying' as const,
  attemptId: 'attempt',
  treeHash: binding.treeHash,
  artifactSetHash: binding.artifactSetHash,
};
it('rejects direct acceptance without the review state', () =>
  expect(() => nativeAcceptanceTask(task, 'accepted', evidence)).toThrow(
    'ILLEGAL_TRANSITION',
  ));
it.each(['taskId', 'attemptId', 'treeHash', 'artifactSetHash'] as const)(
  'rejects stale %s binding',
  (field) => {
    const value = field.endsWith('Hash') ? 'f'.repeat(64) : 'other';
    const forged = {
      ...evidence,
      [field]: value,
      receipts: evidence.receipts.map((receipt) => ({
        ...receipt,
        [field]: value,
      })),
    };
    expect(() =>
      nativeAcceptanceTask(task, 'ready_for_acceptance', forged),
    ).toThrow('STALE_EVIDENCE');
  },
);
it('requires the configured check set', () =>
  expect(() =>
    nativeAcceptanceTask(
      { ...task, requiredCheckIds: ['other'] },
      'ready_for_acceptance',
      evidence,
    ),
  ).toThrow('CHECK_FAILED'));
it('requires matching native qualification at explicit acceptance', () => {
  const prepared = nativeAcceptanceTask(task, 'ready_for_acceptance', evidence);
  expect(() =>
    nativeAcceptanceTask(
      {
        ...prepared,
        nativeQualification: {
          connectionId: 'other',
          runtimeKind: 'codex',
          classification: 'offline',
        },
      },
      'accepted',
      evidence,
    ),
  ).toThrow('STALE_EVIDENCE');
});
it('clears native qualification when work is revised', () => {
  const prepared = nativeAcceptanceTask(task, 'ready_for_acceptance', evidence);
  expect(
    reviseTask(prepared, {
      objective: 'New work',
      requiredCheckIds: ['test'],
      acceptanceCriteria: ['Pass'],
    }).nativeQualification,
  ).toBeUndefined();
});
