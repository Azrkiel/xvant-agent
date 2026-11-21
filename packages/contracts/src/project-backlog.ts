import { z } from 'zod';
import { idSchema } from './index.ts';

const text = z.string().trim().min(1).max(2000);
export const backlogRevision = z.number().int().positive();
const note = {
  id: idSchema,
  summary: text,
  milestoneId: idSchema.optional(),
};

export const projectBacklogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: idSchema,
  projectVersion: backlogRevision,
  policyVersion: backlogRevision,
  revision: backlogRevision,
  reason: text,
  milestones: z
    .array(
      z.strictObject({
        id: idSchema,
        title: text,
        reason: text,
        priority: z.number().int().min(-100).max(100),
        dependsOn: z.array(idSchema).max(19),
        requirementIds: z.array(idSchema).min(1).max(32),
      }),
    )
    .min(1)
    .max(20),
  notes: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ ...note, kind: z.literal('decision') }),
        z.strictObject({
          ...note,
          kind: z.literal('question'),
          nextAction: text,
        }),
        z.strictObject({
          ...note,
          kind: z.literal('blocker'),
          nextAction: text,
        }),
      ]),
    )
    .max(64),
});

export type ProjectBacklog = z.infer<typeof projectBacklogSchema>;
