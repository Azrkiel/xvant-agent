import { z } from 'zod';
import { hashSchema, idSchema } from './index.ts';
import { revisionSchema } from './context.ts';

const text = z.string().trim().min(1).max(10000);
const shortText = z.string().trim().min(1).max(2000);
/** Worker-authored continuation notes. They are data for the recipient, never policy. */
export const handoffInputSchema = z.strictObject({
  id: idSchema,
  attemptId: idSchema,
  fromWorkerId: idSchema,
  toWorkerId: idSchema,
  baseRevision: revisionSchema,
  workspaceTreeHash: hashSchema.optional(),
  summary: text,
  completed: z.array(shortText).max(32),
  remaining: z.array(shortText).max(32),
  openQuestions: z.array(shortText).max(32),
  failedAttempts: z
    .array(
      z.strictObject({
        attemptId: idSchema,
        reason: z.enum([
          'quota',
          'worker_failed',
          'invalid_event',
          'unknown',
          'verifier_failed',
          'cancelled',
        ]),
        summary: shortText,
      }),
    )
    .max(16),
  artifacts: z
    .array(
      z.strictObject({
        hash: hashSchema,
        mediaType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]{1,64}$/),
        description: z.string().trim().min(1).max(500),
      }),
    )
    .max(64),
});
export type HandoffInput = z.input<typeof handoffInputSchema>;
/** Objective, criteria and work revision are copied from the controller's task record. */
export const handoffSchema = handoffInputSchema.extend({
  version: z.literal(1),
  projectId: idSchema,
  taskId: idSchema,
  workRevision: z.number().int().nonnegative(),
  objective: text,
  acceptanceCriteria: z.array(text).min(1).max(32),
  createdAt: z.number().int().nonnegative(),
  handoffHash: hashSchema,
});
export type Handoff = z.infer<typeof handoffSchema>;
