import { z } from 'zod';
import { hashSchema, idSchema } from './index.ts';

/** Git commit IDs: SHA-1 or SHA-256 object format. */
export const revisionSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
/** Repository-relative POSIX path; never absolute, drive-qualified, or escaping. */
export const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !/^[A-Za-z]:/.test(path) &&
      !path.includes('\0') &&
      path.split('/').every((part) => part && part !== '.' && part !== '..'),
  );
const text = z.string().trim().min(1).max(10000);
export const contextItemSchema = z
  .strictObject({
    id: idSchema,
    kind: z.enum([
      'file',
      'decision',
      'artifact',
      'failure',
      'question',
      'memory',
    ]),
    required: z.boolean(),
    priority: z.number().int().min(0).max(100),
    content: z.string().min(1).max(1_000_000),
    decisionStatus: z.enum(['proposed', 'accepted', 'superseded']).optional(),
    provenance: z.strictObject({
      source: z.enum(['repository', 'memory', 'handoff', 'user', 'controller']),
      projectId: idSchema,
      ref: z.string().min(1).max(1024),
      contentHash: hashSchema,
      revision: revisionSchema.optional(),
    }),
  })
  .refine(
    (item) =>
      (item.kind === 'decision') === (item.decisionStatus !== undefined),
  );
export type ContextItem = z.infer<typeof contextItemSchema>;
const header = {
  projectId: idSchema,
  taskId: idSchema,
  attemptId: idSchema.optional(),
  objective: text,
  acceptanceCriteria: z.array(text).min(1).max(32),
  baseRevision: revisionSchema,
  workspaceTreeHash: hashSchema.optional(),
  recipient: z.strictObject({
    workerId: idSchema,
    role: z.enum(['coordinator', 'lead', 'worker', 'reviewer']),
  }),
  ownership: z.strictObject({
    writablePaths: z.array(relativePathSchema).max(64),
  }),
  policy: z.strictObject({
    permissionProfile: idSchema,
    allowedTools: z
      .array(z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/))
      .max(64),
  }),
  skills: z
    .array(
      z.strictObject({
        id: idSchema,
        version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/),
        hash: hashSchema,
      }),
    )
    .max(16),
};
export const contextPacketInputSchema = z.strictObject({
  ...header,
  budget: z.strictObject({
    maxTokens: z.number().int().min(256).max(2_000_000),
  }),
  items: z.array(contextItemSchema).max(512),
});
export type ContextPacketInput = z.input<typeof contextPacketInputSchema>;
export const contextManifestEntrySchema = z.strictObject({
  id: idSchema,
  kind: contextItemSchema.shape.kind,
  ref: z.string().min(1).max(1024),
  decision: z.enum(['included', 'omitted']),
  reason: z.enum(['required', 'priority', 'budget', 'cross_project']),
  tokens: z.number().int().nonnegative(),
});
export type ContextManifestEntry = z.infer<typeof contextManifestEntrySchema>;
export const contextPacketSchema = z.strictObject({
  version: z.literal(1),
  packetHash: hashSchema,
  ...header,
  items: z.array(contextItemSchema).max(512),
  manifest: z.array(contextManifestEntrySchema).max(512),
  tokens: z.strictObject({
    estimator: z.literal('utf8-bytes-div-3'),
    budget: z.number().int().min(256),
    core: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
  }),
});
export type ContextPacket = z.infer<typeof contextPacketSchema>;
