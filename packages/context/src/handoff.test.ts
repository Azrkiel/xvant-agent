import { describe, expect, it } from 'vitest';
import type { Task } from '../../contracts/src/index.ts';
import type { HandoffInput } from '../../contracts/src/handoff.ts';
import { createHandoff, handoffPacket, verifyHandoff } from './handoff.ts';
import { verifyContextPacket } from './packet.ts';

const task: Task = {
  id: 'task',
  projectId: 'project',
  objective: 'Add a retry limit to the fetch helper',
  requiredCheckIds: ['test'],
  acceptanceCriteria: ['Retries stop after three attempts', 'Tests pass'],
  state: 'running',
  workRevision: 2,
  rowVersion: 9,
  attemptId: 'attempt-2',
};
function input(extra: Partial<HandoffInput> = {}): HandoffInput {
  return {
    id: 'handoff-1',
    attemptId: 'attempt-2',
    fromWorkerId: 'codex-1',
    toWorkerId: 'claude-1',
    baseRevision: 'a'.repeat(40),
    workspaceTreeHash: 'b'.repeat(64),
    summary: 'Added maxRetries option; loop still ignores it.',
    completed: ['Added option type'],
    remaining: ['Enforce maxRetries in the loop', 'Add a test for 3 attempts'],
    openQuestions: ['Should a 429 count as a retry?'],
    failedAttempts: [
      {
        attemptId: 'attempt-1',
        reason: 'verifier_failed',
        summary: 'Retry test timed out after 5s',
      },
    ],
    artifacts: [
      {
        hash: 'c'.repeat(64),
        mediaType: 'text/x-diff',
        description: 'Partial patch for src/fetch.ts',
      },
    ],
    ...extra,
  };
}
const packetOptions = {
  recipient: { workerId: 'claude-1', role: 'worker' as const },
  ownership: { writablePaths: ['src/fetch.ts'] },
  policy: { permissionProfile: 'trusted-local', allowedTools: ['file.read'] },
  skills: [],
  budget: { maxTokens: 4096 },
  items: [],
};

describe('handoff', () => {
  it('takes objective, criteria and revision from the task and seals the record', () => {
    const handoff = createHandoff(task, input(), 5000);
    expect(handoff).toMatchObject({
      version: 1,
      projectId: 'project',
      taskId: 'task',
      workRevision: 2,
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      createdAt: 5000,
    });
    expect(verifyHandoff(handoff)).toBe(handoff.handoffHash);
    expect(Object.isFrozen(handoff.remaining)).toBe(true);
    const tampered = {
      ...JSON.parse(JSON.stringify(handoff)),
      acceptanceCriteria: ['Anything'],
    };
    expect(() => verifyHandoff(tampered)).toThrow('INVALID_EVIDENCE');
  });
  it('accepts handoffs only from the task’s current attempt', () => {
    expect(() =>
      createHandoff(task, input({ attemptId: 'attempt-1' }), 1),
    ).toThrow('STALE_EVIDENCE');
    const { attemptId: _unused, ...idle } = task;
    expect(() => createHandoff(idle, input(), 1)).toThrow('STALE_EVIDENCE');
  });
  it.each([
    [
      'unknown failure reason',
      { failedAttempts: [{ attemptId: 'a', reason: 'oops', summary: 's' }] },
    ],
    [
      'bad artifact hash',
      {
        artifacts: [
          { hash: 'nope', mediaType: 'text/plain', description: 'd' },
        ],
      },
    ],
    [
      'bad media type',
      {
        artifacts: [
          { hash: 'c'.repeat(64), mediaType: 'text', description: 'd' },
        ],
      },
    ],
    ['empty summary', { summary: '  ' }],
    ['bad revision', { baseRevision: 'main' }],
  ])('rejects %s', (_name, extra) => {
    expect(() =>
      createHandoff(task, input(extra as Partial<HandoffInput>), 1),
    ).toThrow('INVALID_INPUT');
  });
  it('builds a recipient packet in which every handoff fact is required', () => {
    const handoff = createHandoff(task, input(), 1);
    const packet = handoffPacket(handoff, packetOptions);
    verifyContextPacket(packet);
    expect(packet).toMatchObject({
      projectId: 'project',
      taskId: 'task',
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      baseRevision: 'a'.repeat(40),
      workspaceTreeHash: 'b'.repeat(64),
    });
    expect(packet.manifest.every((entry) => entry.reason === 'required')).toBe(
      true,
    );
    const text = packet.items.map((item) => item.content).join('\n');
    for (const fact of [
      'Added maxRetries option; loop still ignores it.',
      'Added option type',
      'Enforce maxRetries in the loop',
      'Should a 429 count as a retry?',
      'verifier_failed',
      'Retry test timed out after 5s',
      'c'.repeat(64),
      'Partial patch for src/fetch.ts',
    ])
      expect(text).toContain(fact);
    expect(new Set(packet.items.map((item) => item.kind))).toEqual(
      new Set(['handoff', 'failure', 'question', 'artifact']),
    );
    expect(packet.items[0]!.provenance).toMatchObject({
      source: 'handoff',
      projectId: 'project',
      revision: 'a'.repeat(40),
    });
  });
  it('refuses packets for anyone but the named recipient or with a forged handoff', () => {
    const handoff = createHandoff(task, input(), 1);
    expect(() =>
      handoffPacket(handoff, {
        ...packetOptions,
        recipient: { workerId: 'opencode-1', role: 'worker' },
      }),
    ).toThrow('INVALID_INPUT');
    const forged = { ...handoff, summary: 'Nothing left to do' };
    expect(() => handoffPacket(forged, packetOptions)).toThrow(
      'INVALID_EVIDENCE',
    );
  });
  it('fails rather than dropping handoff facts when the budget is too small', () => {
    const handoff = createHandoff(
      task,
      input({ summary: 'Long notes. '.repeat(400) }),
      1,
    );
    expect(() =>
      handoffPacket(handoff, { ...packetOptions, budget: { maxTokens: 512 } }),
    ).toThrow('LIMIT_EXCEEDED');
  });
});
