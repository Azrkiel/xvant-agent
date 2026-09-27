import { z } from 'zod';
import { idSchema } from './index.ts';

export const providerKindSchema = z.enum(['codex', 'claude', 'opencode']);
export type ProviderKind = z.infer<typeof providerKindSchema>;
// Native identifiers are opaque; never use them as filesystem paths.
export const nativeIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const versionSchema = z.string().min(1).max(128);
export const providerWorkerSchema = z.strictObject({
  id: idSchema,
  alias: idSchema,
  runtimeKind: providerKindSchema,
  hostId: idSchema,
  endpointId: idSchema,
  nativeSessionId: nativeIdSchema,
  runtimeVersion: versionSchema,
  adapterVersion: versionSchema,
  mode: z.enum([
    'managed',
    'attached-readonly',
    'attached-control',
    'imported',
  ]),
  quotaGroupId: idSchema,
});
export type ProviderWorker = z.infer<typeof providerWorkerSchema>;
export const qualificationSchema = z.strictObject({
  runtimeKind: providerKindSchema,
  runtimeVersion: versionSchema,
  adapterVersion: versionSchema,
  hostId: idSchema,
  endpointId: idSchema,
  quotaGroupId: idSchema,
  classification: z.enum(['offline', 'live']),
  auth: z.enum(['passed', 'unknown', 'failed']),
  billing: z.enum(['subscription', 'unknown', 'api']),
  capabilities: z
    .array(
      z.enum([
        'run',
        'cancel',
        'reconcile',
        'resume',
        'steer',
        'history',
        'attach-control',
      ]),
    )
    .max(7),
});
export const providerBindingSchema = z.strictObject({
  taskId: idSchema,
  attemptId: idSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  nativeRunId: nativeIdSchema,
});
export type ProviderBinding = z.infer<typeof providerBindingSchema>;
const eventBase = {
  ...providerBindingSchema.shape,
  workerId: idSchema,
  runtimeKind: providerKindSchema,
  nativeSessionId: nativeIdSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const providerFailureSchema = z.enum([
  'AUTH_REQUIRED',
  'QUOTA_BLOCKED',
  'MODEL_UNAVAILABLE',
  'VERSION_UNSUPPORTED',
  'OPERATION_UNKNOWN',
  'WORKER_FAILED',
]);
export const providerEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...eventBase,
    kind: z.literal('output'),
    text: z.string().max(16384),
  }),
  z.strictObject({ ...eventBase, kind: z.literal('completed') }),
  z.strictObject({ ...eventBase, kind: z.literal('cancelled') }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('failed'),
    code: providerFailureSchema,
  }),
]);
export const usageSampleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ quotaGroupId: idSchema, kind: z.literal('unknown') }),
  z.strictObject({
    quotaGroupId: idSchema,
    kind: z.literal('measured'),
    tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    quotaGroupId: idSchema,
    kind: z.literal('estimated'),
    tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
]);
