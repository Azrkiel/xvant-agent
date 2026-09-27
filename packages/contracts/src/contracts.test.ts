import { describe, expect, it } from 'vitest';
import {
  createTaskSchema,
  workerSchema,
  eventSchema,
  DomainError,
  parse,
} from './index.ts';
const input = {
  id: 'task_a',
  projectId: 'project_a',
  objective: 'Implement routing',
  requiredCheckIds: ['unit'],
  acceptanceCriteria: ['Tests pass'],
};
describe('runtime contracts', () => {
  it('parses a valid task request', () =>
    expect(parse(createTaskSchema, input)).toEqual(input));
  it.each(['', '../task', 'task\n', '9task', 'a'.repeat(65)])(
    'rejects unsafe identifier %j',
    (id) =>
      expect(() => parse(createTaskSchema, { ...input, id })).toThrow(
        DomainError,
      ),
  );
  it.each([
    { requiredCheckIds: [] },
    { requiredCheckIds: ['unit', 'unit'] },
    { acceptanceCriteria: [] },
    { objective: ' ' },
    { secret: 'unexpected' },
  ])('rejects incomplete or unknown task fields %j', (change) =>
    expect(() => parse(createTaskSchema, { ...input, ...change })).toThrow(
      DomainError,
    ),
  );
  it('validates composite worker identity', () =>
    expect(
      workerSchema.safeParse({
        id: 'worker_a',
        alias: 'coder',
        hostId: 'local',
        runtimeKind: 'simulated',
        nativeSessionId: 'session_a',
      }).success,
    ).toBe(true));
  it('rejects an unsupported runtime', () =>
    expect(
      workerSchema.safeParse({
        id: 'worker_a',
        alias: 'coder',
        hostId: 'local',
        runtimeKind: 'fake',
        nativeSessionId: 'session_a',
      }).success,
    ).toBe(false));
  it('requires explicit simulation labels on simulated events', () =>
    expect(
      eventSchema.safeParse({
        schemaVersion: 1,
        sequence: 1,
        taskId: 'task_a',
        attemptId: 'attempt_a',
        workerId: 'worker_a',
        runtimeKind: 'simulated',
        kind: 'started',
        simulated: false,
      }).success,
    ).toBe(false));
  it('does not leak raw untrusted data into validation errors', () => {
    try {
      parse(createTaskSchema, { objective: 'SECRET_TOKEN' });
    } catch (error) {
      expect(String(error)).not.toContain('SECRET_TOKEN');
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
});
