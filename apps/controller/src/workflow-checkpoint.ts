import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hashSchema, idSchema } from '../../../packages/contracts/src/index.ts';
import { revisionSchema } from '../../../packages/contracts/src/context.ts';
import { runtimeKindSchema } from '../../../packages/contracts/src/providers.ts';
import { solutionInputSchema } from '../../../packages/contracts/src/lessons.ts';
import { planSchema } from '../../../packages/core/src/plan.ts';

const count = z.number().int().nonnegative();
const positive = z.number().int().positive();
const text = z.string().min(1);
export const checkSchema = z.strictObject({
  executable: text,
  args: z.array(z.string()),
  windowsVerbatimArguments: z.boolean().optional(),
});
const workerSchema = z.strictObject({
  alias: idSchema,
  runtimeKind: runtimeKindSchema,
  quotaGroupId: text,
  roles: z.array(z.enum(['worker', 'reviewer', 'planner'])),
  preferredReviewer: z.boolean().optional(),
  model: text.optional(),
  tier: z.enum(['light', 'standard']).optional(),
});
const specSchema = z
  .strictObject({
    id: idSchema,
    projectId: idSchema,
    repository: text,
    baseRevision: revisionSchema,
    objective: text,
    acceptanceCriteria: z.array(z.string()),
    checks: z.record(z.string().min(1).max(64), checkSchema),
    nodeChecks: z.array(z.string()).default([]),
    plan: z.json().optional(),
    maxActive: positive.default(3),
    maxRepairs: count.default(2),
    maxReviewRepairs: count.default(1),
    checkTimeoutMs: positive.default(10 * 60 * 1000),
    review: z.boolean().default(true),
    lessons: z.boolean().default(true),
    lessonScope: text.nullable(),
  })
  .refine(({ nodeChecks, checks }) =>
    nodeChecks.every((id) => Object.hasOwn(checks, id)),
  );

const lessonCount = z.strictObject({ passed: count, failed: count });
const lessonSnapshot = z.strictObject({
  stats: z.strictObject({
    scope: z.string().optional(),
    challenges: count,
    solutions: count,
    hinted: count,
    errors: count,
    repairs: z.strictObject({ hinted: lessonCount, unhinted: lessonCount }),
  }),
  unverified: z.array(solutionInputSchema),
});
const pendingRepair = z.strictObject({
  challenges: z.array(z.tuple([z.string(), z.string()])),
  change: z.strictObject({
    summary: z.string(),
    files: z.array(z.string()),
    patchHash: hashSchema.nullable(),
    taskId: idSchema,
    alias: idSchema,
  }),
  suggested: z.array(z.string()),
  hinted: z.boolean(),
  failing: z.array(z.string()).optional(),
});

const workflowSchema = z.strictObject({
  schemaVersion: z.literal(1),
  orchestrationVersion: z.literal('2'),
  // Existing roots carry their explicit trusted-local/manual authority.
  authority: z.literal('legacy-manual'),
  spec: specSchema,
  workers: z.array(workerSchema),
  runtimeBindings: z.record(runtimeKindSchema.or(z.string()), z.string()),
  verifierConfigHash: hashSchema,
  stateRoot: text,
  turnTimeoutMs: positive,
  progress: z.strictObject({
    step: z.enum([
      'initialize',
      'plan',
      'nodes',
      'checks',
      'checkRepair',
      'review',
      'reviewRepair',
      'finish',
      'done',
    ]),
    plannerTries: count,
    plannerFeedback: z.string(),
    turnCount: count,
    checkRound: count,
    reviewRound: count,
    completed: z.record(idSchema, z.array(idSchema)),
    hintedNodes: z.array(idSchema),
    pendingFix: pendingRepair.nullable(),
    pendingReviewFix: pendingRepair.nullable(),
    checkChallenges: z.array(z.tuple([z.string(), z.string()])),
    reviewChallenges: z.array(z.tuple([z.string(), z.string()])),
    rejected: z.boolean(),
    lessonSnapshot: lessonSnapshot.optional(),
  }),
});
export type WorkflowCheckpoint = z.infer<typeof workflowSchema>;
export type PendingRepair = z.infer<typeof pendingRepair>;
export type LessonSnapshot = z.infer<typeof lessonSnapshot>;
export const verifierHash = (
  spec: Pick<
    WorkflowCheckpoint['spec'],
    'checks' | 'nodeChecks' | 'checkTimeoutMs'
  >,
) =>
  createHash('sha256')
    .update(JSON.stringify([spec.checks, spec.nodeChecks, spec.checkTimeoutMs]))
    .digest('hex');

export function parseCheckpoint(value: unknown): WorkflowCheckpoint {
  if (value === null || value === undefined)
    throw new Error('CHECKPOINT_UNAVAILABLE');
  const result = workflowSchema.safeParse(value);
  if (!result.success) throw new Error('CHECKPOINT_INVALID');
  const checkpoint = result.data;
  if (checkpoint.verifierConfigHash !== verifierHash(checkpoint.spec))
    throw new Error('CHECKPOINT_INVALID');
  return checkpoint;
}

export function createCheckpoint(
  input: Omit<
    WorkflowCheckpoint,
    | 'schemaVersion'
    | 'orchestrationVersion'
    | 'authority'
    | 'verifierConfigHash'
    | 'progress'
    | 'spec'
    | 'workers'
  > & {
    spec: unknown;
    workers: unknown;
  },
): WorkflowCheckpoint {
  const spec = specSchema.parse(input.spec);
  return parseCheckpoint({
    ...input,
    spec,
    schemaVersion: 1,
    orchestrationVersion: '2',
    authority: 'legacy-manual',
    verifierConfigHash: verifierHash(spec),
    progress: {
      step: 'initialize',
      plannerTries: 0,
      plannerFeedback: '',
      turnCount: 0,
      checkRound: 0,
      reviewRound: 0,
      completed: {},
      hintedNodes: [],
      pendingFix: null,
      pendingReviewFix: null,
      checkChallenges: [],
      reviewChallenges: [],
      rejected: false,
    },
  });
}

export const integrationIdentitySchema = z.strictObject({
  path: text,
  branch: text,
  baseCommit: revisionSchema,
  head: revisionSchema,
});
const nodeStateSchema = z.strictObject({
  node: planSchema.shape.nodes.element,
  status: z.enum([
    'pending',
    'running',
    'integrated',
    'failed',
    'needs_attention',
  ]),
  repairs: count,
  attempts: z.array(
    z.strictObject({
      taskId: idSchema,
      alias: idSchema,
      status: z.string(),
      files: z.array(z.string()),
      failure: z.string().optional(),
    }),
  ),
  notes: z.array(z.string()),
  lastFailure: z.string().optional(),
  challenge: z.string().optional(),
  suggested: z.array(z.string()).optional(),
  route: z
    .strictObject({
      alias: idSchema.nullable(),
      reasons: z.array(z.string()),
      excluded: z.array(
        z.strictObject({ alias: idSchema, reason: z.string() }),
      ),
    })
    .optional(),
});
export const checkedResultSchema = z.strictObject({
  id: z.string(),
  status: z.enum(['passed', 'failed']),
  output: z.string(),
});
export const rootProgressSchema = z.strictObject({
  phase: z.enum([
    'planning',
    'running',
    'verifying',
    'reviewing',
    'ready',
    'accepted',
    'failed',
    'needs_attention',
    'cancelled',
  ]),
  repository: text,
  objective: text,
  acceptanceCriteria: z.array(z.string()),
  plan: planSchema.nullable(),
  nodes: z.record(idSchema, nodeStateSchema),
  integration: integrationIdentitySchema.nullable(),
  checks: z.array(
    checkedResultSchema.omit({ output: true }).extend({ head: revisionSchema }),
  ),
  review: z
    .strictObject({
      alias: idSchema,
      approve: z.boolean(),
      findings: z.array(z.string()),
      independent: z.boolean(),
      sameRuntime: z.boolean(),
    })
    .nullable(),
  reviewRepairs: count.optional(),
  reason: z.string().optional(),
  lessons: lessonSnapshot.shape.stats.optional(),
});

export const turnIntentSchema = z.strictObject({
  taskId: idSchema,
  projectId: idSchema,
  alias: idSchema,
  prompt: z.string(),
  workspace: integrationIdentitySchema.omit({ head: true }),
  deadlineAt: positive,
  checks: z.record(z.string(), checkSchema),
  writablePaths: z.array(z.string()),
  lessonScope: z.string().nullable(),
});
export const turnResultSchema = z.strictObject({
  status: z.enum([
    'accepted',
    'verification_failed',
    'failed',
    'cancelled',
    'unknown',
  ]),
  finalText: z.string(),
  patchHash: hashSchema.nullable(),
  files: z.array(z.string()),
  failure: z.string().optional(),
});
export const integrationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('applied'),
    commit: revisionSchema,
    files: z.array(z.string()),
  }),
  z.strictObject({ status: z.literal('empty'), commit: revisionSchema }),
  z.strictObject({ status: z.literal('conflict'), files: z.array(z.string()) }),
]);
export const applyIntentSchema = z.strictObject({
  before: revisionSchema,
  patchHash: hashSchema.nullable(),
  message: z.string(),
});
export const checkIntentSchema = z.strictObject({
  id: z.string(),
  cwd: text,
  head: revisionSchema,
  check: checkSchema,
  deadlineAt: positive,
});
