import { z } from 'zod';

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'ILLEGAL_TRANSITION'
  | 'EVIDENCE_REQUIRED'
  | 'STALE_EVIDENCE'
  | 'CHECK_FAILED'
  | 'INVALID_EVIDENCE'
  | 'DUPLICATE_IDENTITY'
  | 'GRAPH_INVALID'
  | 'LIMIT_EXCEEDED'
  | 'NOT_FOUND'
  | 'WORKER_BUSY'
  | 'INVALID_EVENT'
  | 'VERIFICATION_FAILED';
export class DomainError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(code + ': ' + message);
    this.name = 'DomainError';
    this.code = code;
  }
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new DomainError(
      'INVALID_INPUT',
      'Value does not satisfy the expected contract',
    );
  return result.data;
}
export const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const textSchema = z.string().trim().min(1).max(10000);
const checkIdsSchema = z
  .array(idSchema)
  .min(1)
  .max(32)
  .refine((ids) => new Set(ids).size === ids.length);
export const workInputSchema = z.strictObject({
  objective: textSchema,
  requiredCheckIds: checkIdsSchema,
  acceptanceCriteria: z.array(textSchema).min(1).max(32),
});
export const createTaskSchema = workInputSchema.extend({
  id: idSchema,
  projectId: idSchema,
});
export type CreateTask = z.infer<typeof createTaskSchema>;
export const taskStateSchema = z.enum([
  'draft',
  'queued',
  'running',
  'verifying',
  'ready_for_acceptance',
  'accepted',
  'blocked',
  'paused',
  'needs_rework',
  'needs_attention',
  'cancelling',
  'cancelled',
]);
export type TaskState = z.infer<typeof taskStateSchema>;
export const taskSchema = createTaskSchema.extend({
  state: taskStateSchema,
  workRevision: z.number().int().nonnegative(),
  rowVersion: z.number().int().nonnegative(),
  attemptId: idSchema.optional(),
  treeHash: hashSchema.optional(),
  artifactSetHash: hashSchema.optional(),
  nativeQualification: z
    .strictObject({
      connectionId: idSchema,
      runtimeKind: z.enum(['codex', 'claude', 'opencode']),
      classification: z.literal('offline'),
    })
    .optional(),
});
export type Task = z.infer<typeof taskSchema>;
export const attemptStateSchema = z.enum([
  'reserved',
  'dispatching',
  'running',
  'interrupt_requested',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
]);
export type AttemptState = z.infer<typeof attemptStateSchema>;
export const attemptSchema = z.strictObject({
  id: idSchema,
  taskId: idSchema,
  workerId: idSchema,
  state: attemptStateSchema,
  rowVersion: z.number().int().nonnegative(),
});
export type Attempt = z.infer<typeof attemptSchema>;
export const workerSchema = z.strictObject({
  id: idSchema,
  alias: idSchema,
  hostId: idSchema,
  runtimeKind: z.literal('simulated'),
  nativeSessionId: idSchema,
});
export type Worker = z.infer<typeof workerSchema>;
const binding = {
  taskId: idSchema,
  attemptId: idSchema,
  workRevision: z.number().int().nonnegative(),
  treeHash: hashSchema,
  artifactSetHash: hashSchema,
};
export const receiptSchema = z.strictObject({
  ...binding,
  checkId: idSchema,
  status: z.enum(['passed', 'failed']),
});
export const evidenceSchema = z.strictObject({
  ...binding,
  runtimeKind: z.literal('simulated'),
  receipts: z.array(receiptSchema).max(64),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export const scenarioSchema = z.enum([
  'success',
  'failure',
  'delayed',
  'malformed',
  'quota',
  'unknown',
]);
export type Scenario = z.infer<typeof scenarioSchema>;
const eventBase = {
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  taskId: idSchema,
  attemptId: idSchema,
  workerId: idSchema,
  runtimeKind: z.literal('simulated'),
  simulated: z.literal(true),
};
export const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventBase, kind: z.literal('started') }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('output'),
    text: z.string().max(16384),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('completed'),
    treeHash: hashSchema,
    artifactSetHash: hashSchema,
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('failed'),
    reason: z.literal('SIMULATED_FAILURE'),
  }),
  z.strictObject({ ...eventBase, kind: z.literal('quota') }),
  z.strictObject({ ...eventBase, kind: z.literal('unknown') }),
  z.strictObject({ ...eventBase, kind: z.literal('cancelled') }),
]);
export type RuntimeEvent = z.infer<typeof eventSchema>;
export const runRequestSchema = z.strictObject({
  taskId: idSchema,
  attemptId: idSchema,
  workerId: idSchema,
  scenario: scenarioSchema,
});
export type RunRequest = z.infer<typeof runRequestSchema>;
// unknown at this boundary forces the controller to validate even a faulty adapter.
export interface RuntimeAdapter {
  readonly runtimeKind: 'simulated';
  run(request: RunRequest, signal?: AbortSignal): AsyncIterable<unknown>;
}
