import { z } from 'zod';
import { hashSchema, idSchema } from './index.ts';
import { nativeIdSchema, providerKindSchema } from './providers.ts';
const binding = {
  taskId: idSchema,
  attemptId: idSchema,
  connectionId: idSchema,
  workspaceId: idSchema,
  workRevision: z.number().int().nonnegative(),
  generation: z.number().int().positive(),
  hostId: idSchema,
  runtimeKind: providerKindSchema,
  classification: z.enum(['offline', 'live']),
  nativeSessionId: nativeIdSchema,
  nativeRunId: nativeIdSchema,
  treeHash: hashSchema,
  artifactSetHash: hashSchema,
  workspaceRootHash: hashSchema,
};
export const nativeEvidenceSchema = z
  .strictObject({
    ...binding,
    receipts: z
      .array(
        z.strictObject({
          ...binding,
          checkId: idSchema,
          commandHash: hashSchema,
          status: z.enum(['passed', 'failed']),
        }),
      )
      .min(1)
      .max(32),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const receipt of value.receipts) {
      if (
        seen.has(receipt.checkId) ||
        (Object.keys(binding) as (keyof typeof binding)[]).some(
          (key) => receipt[key] !== value[key],
        )
      )
        context.addIssue({
          code: 'custom',
          message: 'Mismatched or duplicate receipt',
        });
      seen.add(receipt.checkId);
    }
  });
export const nativeVerificationSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('passed'),
      evidence: nativeEvidenceSchema,
    }),
    z.strictObject({
      status: z.literal('failed'),
      evidence: nativeEvidenceSchema,
    }),
    z.strictObject({
      status: z.literal('unknown'),
      reason: z.enum([
        'WORKSPACE_CHANGED',
        'VERIFIER_UNAVAILABLE',
        'VERIFIER_UNCERTAIN',
      ]),
    }),
  ])
  .superRefine((value, context) => {
    if (
      value.status !== 'unknown' &&
      (value.status === 'passed') !==
        value.evidence.receipts.every((receipt) => receipt.status === 'passed')
    )
      context.addIssue({ code: 'custom', message: 'Receipt outcome mismatch' });
  });
export type NativeVerification = z.infer<typeof nativeVerificationSchema>;
export type NativeEvidence = z.infer<typeof nativeEvidenceSchema>;
export const nativeAcceptanceSchema = z.strictObject({
  connectionId: idSchema,
  expectedVersion: z.number().int().nonnegative(),
  reviewedEvidenceHash: hashSchema,
  actorId: idSchema,
  classification: z.enum(['offline', 'live']),
});
