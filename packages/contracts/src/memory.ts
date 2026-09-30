import { z } from 'zod';
import { hashSchema, idSchema } from './index.ts';
import { relativePathSchema, revisionSchema } from './context.ts';

/** Hierarchical namespace such as `architecture/storage`; prefix match is per segment. */
export const memoryNamespaceSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}(?:\/[a-z0-9][a-z0-9-]{0,31}){0,3}$/);
export const memoryStatusSchema = z.enum([
  'proposed',
  'accepted',
  'rejected',
  'superseded',
]);
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export const memoryProposalSchema = z
  .strictObject({
    id: idSchema,
    projectId: idSchema,
    namespace: memoryNamespaceSchema,
    kind: z.enum(['fact', 'convention', 'decision', 'failure', 'question']),
    content: z.string().trim().min(1).max(10000),
    /** `verified` is reserved for controller-derived records backed by trusted checks. */
    confidence: z.enum(['verified', 'reported', 'inferred']),
    supersedes: idSchema.optional(),
    /** Files the record depends on, hashed at `provenance.revision`, for staleness checks. */
    anchors: z
      .array(z.strictObject({ path: relativePathSchema, hash: hashSchema }))
      .max(32)
      .optional(),
    provenance: z.strictObject({
      source: z.enum(['user', 'controller', 'worker', 'import']),
      actorId: idSchema,
      taskId: idSchema.optional(),
      attemptId: idSchema.optional(),
      revision: revisionSchema.optional(),
    }),
  })
  .refine(
    (value) =>
      value.confidence !== 'verified' ||
      value.provenance.source === 'controller',
  )
  .refine(
    (value) =>
      value.provenance.source !== 'worker' ||
      (value.provenance.taskId !== undefined &&
        value.provenance.attemptId !== undefined),
  )
  .refine(
    (value) =>
      !value.anchors ||
      new Set(value.anchors.map((anchor) => anchor.path)).size ===
        value.anchors.length,
  );
export type MemoryProposal = z.input<typeof memoryProposalSchema>;
export type MemoryRecord = z.infer<typeof memoryProposalSchema> & {
  status: MemoryStatus;
  contentHash: string;
  createdAt: number;
  rowVersion: number;
  decidedAt?: number;
  decidedBy?: string;
  supersededBy?: string;
};
export const memorySearchSchema = z.strictObject({
  query: z.string().max(1000).optional(),
  namespaces: z.array(memoryNamespaceSchema).max(16).optional(),
  statuses: z.array(memoryStatusSchema).min(1).max(4).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type MemorySearch = z.input<typeof memorySearchSchema>;
