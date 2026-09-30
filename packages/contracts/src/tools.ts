import { z } from 'zod';
import { hashSchema, idSchema } from './index.ts';

export const toolNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/)
  .max(64);
export const effectClassSchema = z.enum([
  'read',
  'workspace-write',
  'process',
  'network',
  'external-write',
]);
export type EffectClass = z.infer<typeof effectClassSchema>;
export const toolManifestSchema = z
  .strictObject({
    name: toolNameSchema,
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/),
    description: z.string().trim().min(1).max(500),
    effect: effectClassSchema,
    permissions: z.array(z.string().regex(/^[a-z]+(?:\.[a-z]+)*$/)).max(8),
    host: z.enum(['controller', 'workspace']),
    timeoutMs: z.number().int().min(1).max(600_000),
    /** `safe` only for idempotent reads; nothing effectful is retried automatically. */
    retry: z.enum(['safe', 'unsafe']),
    maxResultBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024),
    /**
     * The tool can only execute actions the host registered in advance (for
     * example repository test commands), so registration is the approval.
     */
    preapproved: z.boolean().optional(),
  })
  .refine((m) => m.retry === 'unsafe' || m.effect === 'read')
  .refine((m) => !m.preapproved || m.effect === 'process');
export type ToolManifest = z.infer<typeof toolManifestSchema>;
/** Host-recorded approval for one exact action; it never transfers to another input or attempt. */
export const toolApprovalSchema = z.strictObject({
  actionHash: hashSchema,
  decidedBy: idSchema,
  expiresAt: z.number().int().nonnegative(),
});
export type ToolApproval = z.infer<typeof toolApprovalSchema>;
export const toolReceiptSchema = z.strictObject({
  receiptId: z.string().uuid(),
  tool: z.string().max(64),
  version: z.string().max(32),
  projectId: idSchema,
  taskId: idSchema,
  attemptId: idSchema,
  workerId: idSchema,
  actionHash: hashSchema,
  status: z.enum([
    'succeeded',
    'failed',
    'denied',
    'approval_required',
    'timeout',
  ]),
  code: z.string().max(64).optional(),
  message: z.string().max(500).optional(),
  result: z.unknown().optional(),
  approvedBy: idSchema.optional(),
  artifacts: z.array(hashSchema).max(64).optional(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
});
export type ToolReceipt = z.infer<typeof toolReceiptSchema>;
