import { describe, expect, it } from 'vitest';
import {
  createTask,
  transitionTask,
  reviseTask,
  createAttempt,
  transitionAttempt,
} from './task.ts';
import type {
  Evidence,
  Task,
  TaskState,
  AttemptState,
} from '../../contracts/src/index.ts';
const input = {
  id: 'task_a',
  projectId: 'project_a',
  objective: 'Implement routing',
  requiredCheckIds: ['unit', 'review'],
  acceptanceCriteria: ['Tests pass'],
};
const hash = 'a'.repeat(64);
function active(): Task {
  return {
    ...createTask(input),
    state: 'verifying',
    attemptId: 'attempt_a',
    treeHash: hash,
    artifactSetHash: hash,
  };
}
function evidence(task = active()): Evidence {
  return {
    taskId: task.id,
    attemptId: task.attemptId!,
    workRevision: task.workRevision,
    treeHash: task.treeHash!,
    artifactSetHash: task.artifactSetHash!,
    runtimeKind: 'simulated',
    receipts: task.requiredCheckIds.map((checkId) => ({
      checkId,
      taskId: task.id,
      attemptId: task.attemptId!,
      workRevision: task.workRevision,
      treeHash: task.treeHash!,
      artifactSetHash: task.artifactSetHash!,
      status: 'passed',
    })),
  };
}
describe('task lifecycle and evidence', () => {
  it('queues a draft immutably and increments only row version', () => {
    const t = createTask(input);
    const next = transitionTask(t, 'queued');
    expect(t.state).toBe('draft');
    expect(next).toMatchObject({
      state: 'queued',
      rowVersion: 1,
      workRevision: 0,
    });
  });
  it('rejects running directly to accepted', () =>
    expect(() =>
      transitionTask({ ...active(), state: 'running' }, 'accepted'),
    ).toThrowError(/ILLEGAL_TRANSITION/));
  it('requires evidence before ready', () =>
    expect(() => transitionTask(active(), 'ready_for_acceptance')).toThrowError(
      /EVIDENCE_REQUIRED/,
    ));
  it('rejects empty required checks', () =>
    expect(() => createTask({ ...input, requiredCheckIds: [] })).toThrowError(
      /INVALID_INPUT/,
    ));
  it('rejects missing check receipts', () =>
    expect(() =>
      transitionTask(active(), 'ready_for_acceptance', {
        ...evidence(),
        receipts: evidence().receipts.slice(0, 1),
      }),
    ).toThrowError(/EVIDENCE_REQUIRED/));
  it('rejects stale top-level evidence', () =>
    expect(() =>
      transitionTask(active(), 'ready_for_acceptance', {
        ...evidence(),
        workRevision: 5,
      }),
    ).toThrowError(/STALE_EVIDENCE/));
  it('rejects one stale required receipt', () => {
    const e = evidence();
    e.receipts[0]!.treeHash = 'b'.repeat(64);
    expect(() =>
      transitionTask(active(), 'ready_for_acceptance', e),
    ).toThrowError(/STALE_EVIDENCE/);
  });
  it('rejects a failed review receipt', () => {
    const e = evidence();
    e.receipts[1]!.status = 'failed';
    expect(() =>
      transitionTask(active(), 'ready_for_acceptance', e),
    ).toThrowError(/CHECK_FAILED/);
  });
  it('rejects duplicate receipts', () => {
    const e = evidence();
    e.receipts.push(e.receipts[0]!);
    expect(() =>
      transitionTask(active(), 'ready_for_acceptance', e),
    ).toThrowError(/INVALID_EVIDENCE/);
  });
  it('advances to ready with all current receipts', () =>
    expect(
      transitionTask(active(), 'ready_for_acceptance', evidence()),
    ).toMatchObject({
      state: 'ready_for_acceptance',
      workRevision: 0,
      rowVersion: 1,
    }));
  it('rejects changed artifacts at acceptance', () => {
    const t = transitionTask(active(), 'ready_for_acceptance', evidence());
    expect(() =>
      transitionTask(
        { ...t, artifactSetHash: 'b'.repeat(64) },
        'accepted',
        evidence(),
      ),
    ).toThrowError(/STALE_EVIDENCE/);
  });
  it('accepts current evidence after state-only changes', () => {
    const t = transitionTask(active(), 'ready_for_acceptance', evidence());
    expect(transitionTask(t, 'accepted', evidence()).state).toBe('accepted');
  });
  it.each(['accepted', 'cancelled'] as const)(
    'does not reopen terminal %s',
    (state) =>
      expect(() =>
        transitionTask({ ...active(), state }, 'queued'),
      ).toThrowError(/ILLEGAL_TRANSITION/),
  );
  it('routes an uncertain running task to needs_attention', () =>
    expect(
      transitionTask({ ...active(), state: 'running' }, 'needs_attention')
        .state,
    ).toBe('needs_attention'));
  it('rejects evidence for another task/attempt/runtime', () => {
    for (const change of [
      { taskId: 'other' },
      { attemptId: 'other' },
      { runtimeKind: 'codex' },
    ])
      expect(() =>
        transitionTask(active(), 'ready_for_acceptance', {
          ...evidence(),
          ...change,
        } as Evidence),
      ).toThrow();
  });
  it('rejects unknown or malformed receipt fields', () =>
    expect(() =>
      transitionTask(active(), 'ready_for_acceptance', {
        ...evidence(),
        receipts: [{}],
      } as Evidence),
    ).toThrowError(/INVALID_INPUT/));
  it('rejects unexpected checks', () => {
    const e = evidence();
    e.receipts.push({ ...e.receipts[0]!, checkId: 'extra' });
    expect(() =>
      transitionTask(active(), 'ready_for_acceptance', e),
    ).toThrowError(/INVALID_EVIDENCE/);
  });
  it('requires task artifacts and attempt to verify', () => {
    const t = createTask(input);
    expect(() =>
      transitionTask(
        { ...t, state: 'verifying' },
        'ready_for_acceptance',
        evidence(),
      ),
    ).toThrowError(/STALE_EVIDENCE/);
  });
  it('a work edit invalidates evidence and increments work revision', () => {
    const t = transitionTask(active(), 'ready_for_acceptance', evidence());
    const changed = reviseTask(t, {
      objective: 'New objective',
      requiredCheckIds: ['new'],
      acceptanceCriteria: ['New requirement'],
    });
    expect(changed).toMatchObject({
      state: 'needs_rework',
      workRevision: 1,
      rowVersion: 2,
    });
    expect(changed.attemptId).toBeUndefined();
    expect(t.objective).toBe(input.objective);
  });
  it('rejects edits during execution or after termination', () => {
    for (const state of [
      'running',
      'verifying',
      'accepted',
      'cancelled',
      'cancelling',
    ] as TaskState[])
      expect(() => reviseTask({ ...active(), state }, input)).toThrow();
  });
  it('does not let callers mutate task arrays through a transition', () => {
    const t = createTask(input);
    const q = transitionTask(t, 'queued');
    q.requiredCheckIds.push('changed');
    expect(t.requiredCheckIds).toEqual(input.requiredCheckIds);
  });
  it('checks every legal and illegal state pair', () => {
    const table: Record<TaskState, TaskState[]> = {
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
    for (const from of Object.keys(table) as TaskState[])
      for (const to of Object.keys(table) as TaskState[]) {
        const call = () =>
          transitionTask({ ...active(), state: from }, to, evidence());
        if (table[from].includes(to)) expect(call).not.toThrow();
        else expect(call).toThrowError(/ILLEGAL_TRANSITION/);
      }
  });
});
describe('attempt lifecycle', () => {
  it('creates a reserved attempt with validated identities', () =>
    expect(createAttempt('attempt_a', 'task_a', 'worker_a')).toMatchObject({
      state: 'reserved',
      rowVersion: 0,
    }));
  it('rejects malformed attempt ids', () =>
    expect(() => createAttempt('../bad', 'task_a', 'worker_a')).toThrow());
  it('covers legal transitions and rejects all others', () => {
    const table: Record<AttemptState, AttemptState[]> = {
      reserved: ['dispatching', 'cancelled'],
      dispatching: ['running', 'failed', 'cancelled', 'unknown'],
      running: ['interrupt_requested', 'succeeded', 'failed', 'unknown'],
      interrupt_requested: ['cancelled', 'succeeded', 'failed', 'unknown'],
      succeeded: [],
      failed: [],
      cancelled: [],
      unknown: [],
    };
    for (const from of Object.keys(table) as AttemptState[])
      for (const to of Object.keys(table) as AttemptState[]) {
        const original = {
          ...createAttempt('attempt_a', 'task_a', 'worker_a'),
          state: from,
        };
        const call = () => transitionAttempt(original, to);
        if (table[from].includes(to)) {
          expect(call().rowVersion).toBe(1);
          expect(original.rowVersion).toBe(0);
        } else expect(call).toThrowError(/ILLEGAL_TRANSITION/);
      }
  });
});
