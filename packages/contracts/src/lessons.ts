import { z } from 'zod';
import { idSchema } from './index.ts';
import { relativePathSchema } from './context.ts';

/**
 * The lesson graph: challenges XVANT met while working (a failing check, an
 * integration conflict, a review finding) linked to the changes that did and
 * did not resolve them. It lets later work start from what is already known
 * instead of rediscovering a fix. Only the host writes it, and a solution
 * counts as verified only when host-registered checks passed on it.
 */
export const lessonSourceSchema = z.enum(['node', 'checks', 'review']);
export type LessonSource = z.infer<typeof lessonSourceSchema>;
export const lessonRelationSchema = z.enum([
  /** challenge -> solution: the change resolved the challenge. */
  'solved_by',
  /** challenge -> solution: the change was tried and the challenge remained. */
  'not_solved_by',
  /** challenge -> challenge: working on the first one ran into the second. */
  'followed_by',
]);
export type LessonRelation = z.infer<typeof lessonRelationSchema>;
const checkIdSchema = z.string().min(1).max(64);
const filesSchema = z.array(relativePathSchema).max(64);

export const challengeInputSchema = z.strictObject({
  projectId: idSchema,
  /** Failure text as observed; its first lines name the challenge. */
  failure: z.string().trim().min(1).max(200_000),
  source: lessonSourceSchema,
  /** What the work was trying to do, so similar work can find it. */
  context: z.string().max(4000).optional(),
  files: filesSchema.optional(),
  provenance: z.strictObject({
    graphId: idSchema,
    taskId: idSchema.optional(),
  }),
});
export type ChallengeInput = z.input<typeof challengeInputSchema>;

export const solutionInputSchema = z.strictObject({
  projectId: idSchema,
  /** The worker's own account of the change: reported, not verified. */
  summary: z.string().max(200_000),
  files: filesSchema,
  /** Unified diff of the change; stored as a bounded excerpt. */
  diff: z.string().max(10_000_000),
  /** Host checks that passed on the change; empty means it was not verified. */
  checks: z.array(checkIdSchema).max(32),
  provenance: z.strictObject({
    graphId: idSchema,
    taskId: idSchema.optional(),
    alias: z.string().max(64).optional(),
  }),
});
export type SolutionInput = z.input<typeof solutionInputSchema>;

export interface ChallengeNode {
  kind: 'challenge';
  id: string;
  projectId: string;
  /** Normalized failure text; equal signatures are the same challenge. */
  signature: string;
  title: string;
  /** The latest observed failure text, bounded. */
  detail: string;
  source: LessonSource;
  context?: string;
  files: string[];
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Most recent runs that met it, newest last. */
  seenIn: { graphId: string; taskId?: string | undefined }[];
}
export interface SolutionNode {
  kind: 'solution';
  id: string;
  projectId: string;
  summary: string;
  files: string[];
  diff: string;
  checks: string[];
  createdAt: number;
  provenance: {
    graphId: string;
    taskId?: string | undefined;
    alias?: string | undefined;
  };
  /** What happened when this solution was shown to a later repair. */
  usage: { suggested: number; succeeded: number; failed: number };
}
export type LessonNode = ChallengeNode | SolutionNode;
export interface LessonEdge {
  projectId: string;
  from: string;
  to: string;
  relation: LessonRelation;
  count: number;
  firstAt: number;
  lastAt: number;
}
export interface RankedSolution {
  solution: SolutionNode;
  edge: LessonEdge;
  score: number;
}
export interface LessonMatch {
  challenge: ChallengeNode;
  /** True when the signature matched exactly, not just by similar words. */
  exact: boolean;
  solutions: RankedSolution[];
  deadEnds: { solution: SolutionNode; edge: LessonEdge }[];
}
export const lessonSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(20_000),
  limit: z.number().int().min(1).max(20).optional(),
});
export type LessonSearch = z.input<typeof lessonSearchSchema>;
