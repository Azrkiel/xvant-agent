import { z } from 'zod';
import { relativePathSchema, revisionSchema } from './context.ts';
import { hashSchema, idSchema } from './index.ts';
import { runtimeKindSchema } from './providers.ts';

const text = z.string().trim().min(1).max(10000);
const version = z.number().int().positive();
const unique = <T extends z.ZodType<string>>(item: T, max = 64) =>
  z
    .array(item)
    .max(max)
    .refine((items) => new Set(items).size === items.length);
const requirementIds = unique(idSchema, 32).refine((ids) => ids.length > 0);
/** Portable, literal Git path prefixes. A single dot grants the repository root. */
const contractPath = relativePathSchema.refine(
  (path) =>
    !path.includes(':') &&
    path
      .split('/')
      .every((part) => !/[. ]$/.test(part) && part.toLowerCase() !== '.git'),
);
const scope = z.strictObject({
  repository: z.string().min(1).max(4096),
  paths: unique(z.union([z.literal('.'), contractPath])).refine(
    (paths) => paths.length > 0,
  ),
  excludedPaths: unique(contractPath),
});
const delivery = z.strictObject({
  localCandidate: z.boolean(),
  createPr: z.boolean(),
  merge: z.boolean(),
});
const authority = z.strictObject({
  scope,
  actions: unique(z.enum(['read', 'report', 'edit', 'verify'])),
  providers: unique(runtimeKindSchema),
  budget: z.strictObject({
    attempts: version,
    wallTimeMs: version,
    tokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
  }),
  delivery,
});
const intent = z.strictObject({ actorId: idSchema, objective: text });
const record = { schemaVersion: z.literal(1) };

export const projectContractSchema = z.strictObject({
  ...record,
  id: idSchema,
  version,
  ownerIntent: intent,
  requirements: z
    .array(z.strictObject({ id: idSchema, description: text }))
    .min(1)
    .max(32)
    .refine(
      (requirements) =>
        new Set(requirements.map(({ id }) => id)).size === requirements.length,
    ),
  exclusions: z.array(text).max(32),
  scope,
});

export const projectPolicySchema = z.strictObject({
  ...record,
  projectId: idSchema,
  projectVersion: version,
  version,
  ownerId: idSchema,
  authority,
  verifier: z.strictObject({
    id: idSchema,
    configHash: hashSchema,
    checks: z
      .array(z.strictObject({ id: idSchema, requirementIds }))
      .max(32)
      .refine(
        (checks) => new Set(checks.map(({ id }) => id)).size === checks.length,
      ),
  }),
  review: z.discriminatedUnion('required', [
    z.strictObject({ required: z.literal(false) }),
    z.strictObject({
      required: z.literal(true),
      reviewers: unique(idSchema, 32).refine((ids) => ids.length > 0),
    }),
  ]),
  automaticAcceptance: z.boolean(),
  escalation: z
    .strictObject({
      onBlock: z.enum(['owner', 'stop']),
      allowManualException: z.boolean(),
    })
    .refine((rule) => !rule.allowManualException || rule.onBlock === 'owner'),
});

const task = {
  ...record,
  id: idSchema,
  projectId: idSchema,
  projectVersion: version,
  policyVersion: version,
  baseRevision: revisionSchema,
  parentTaskId: idSchema.optional(),
  ownerIntent: intent,
  managerBrief: z.strictObject({ actorId: idSchema, description: text }),
  requirementIds,
  authority,
};
export const projectTaskSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...task, type: z.literal('scout') }),
  z.strictObject({
    ...task,
    type: z.literal('ship'),
    sourceReport: z
      .strictObject({ taskId: idSchema, revision: hashSchema })
      .optional(),
  }),
]);

/** Each verifier and reviewer attests to the same fully resolved subject. */
export const completionSubjectSchema = z.strictObject({
  projectId: idSchema,
  projectVersion: version,
  policyVersion: version,
  taskId: idSchema,
  attemptId: idSchema,
  baseRevision: revisionSchema,
  revision: revisionSchema,
  requirementIds,
  verifierId: idSchema,
  verifierConfigHash: hashSchema,
});
export const sourcedReportSchema = z.strictObject({
  summary: text,
  sources: z
    .array(
      z.strictObject({
        path: contractPath,
        revision: revisionSchema,
        observation: text,
      }),
    )
    .min(1)
    .max(32),
});
const result = {
  repository: scope.shape.repository,
  baseRevision: revisionSchema,
  revision: revisionSchema,
  changedPaths: unique(contractPath, 4096),
  provider: runtimeKindSchema,
  producers: unique(idSchema, 32).refine((ids) => ids.length > 0),
};
export const contractOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown') }),
  z.strictObject({ status: z.literal('failed') }),
  z.strictObject({
    ...result,
    status: z.literal('report'),
    revision: hashSchema,
    report: sourcedReportSchema,
  }),
  z.strictObject({ ...result, status: z.literal('candidate') }),
]);
export type SourcedReport = z.infer<typeof sourcedReportSchema>;

export const completionObservationSchema = z.strictObject({
  attemptId: idSchema,
  outcome: contractOutcomeSchema,
  verification: z
    .strictObject({
      subject: completionSubjectSchema,
      checks: z
        .array(
          z.strictObject({
            id: idSchema,
            status: z.enum(['passed', 'failed', 'unknown']),
          }),
        )
        .max(32)
        .refine(
          (checks) =>
            new Set(checks.map(({ id }) => id)).size === checks.length,
        ),
    })
    .optional(),
  review: z
    .strictObject({
      subject: completionSubjectSchema,
      reviewerId: idSchema,
      status: z.enum(['approved', 'rejected', 'unknown']),
    })
    .optional(),
});

export const acceptContractSchema = z.strictObject({
  expectedVersion: version,
  attemptId: idSchema,
  revision: revisionSchema,
  mode: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('automatic') }),
    z.strictObject({ kind: z.literal('manual'), actorId: idSchema }),
    z.strictObject({
      kind: z.literal('exception'),
      actorId: idSchema,
      reason: text,
    }),
  ]),
});
export type ProjectContract = z.infer<typeof projectContractSchema>;
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;
export type ProjectTask = z.infer<typeof projectTaskSchema>;
export type CompletionSubject = z.infer<typeof completionSubjectSchema>;
export type CompletionObservation = z.infer<typeof completionObservationSchema>;
export type AcceptContract = z.infer<typeof acceptContractSchema>;
