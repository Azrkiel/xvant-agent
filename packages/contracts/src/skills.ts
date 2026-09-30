import { z } from 'zod';
import { hashSchema } from './index.ts';
import { toolNameSchema } from './tools.ts';

export const skillIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
export const semverSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const nameSchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,47}$/);
export const skillRuntimeSchema = z.enum([
  'codex',
  'claude',
  'opencode',
  'native-local',
  'simulated',
]);
export const lifecycleEventSchema = z.enum([
  'before_step',
  'after_step',
  'before_tool',
  'after_tool',
  'on_complete',
  'on_failure',
]);
/**
 * Hooks are declarations. `record_evidence` and `require_check` are built-in
 * controller actions; `executable` hooks name code the host must register
 * separately, and a skill can never supply that code or its permissions.
 */
export const hookDeclarationSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
  event: lifecycleEventSchema,
  action: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('record_evidence'),
      label: text(100),
    }),
    z.strictObject({
      kind: z.literal('require_check'),
      checkId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    }),
    z.strictObject({
      kind: z.literal('executable'),
      handler: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
    }),
  ]),
});
export type HookDeclaration = z.infer<typeof hookDeclarationSchema>;
/**
 * Strict: there is deliberately no field through which a skill could grant a
 * tool, permission, profile, approval or budget. `requiredTools` only limits
 * where a skill can be selected.
 */
export const skillManifestSchema = z
  .strictObject({
    id: skillIdSchema,
    version: semverSchema,
    description: text(500),
    origin: z.literal('xvant-original'),
    license: z.literal('Apache-2.0'),
    inputs: z
      .array(
        z.strictObject({
          name: nameSchema,
          description: text(300),
          required: z.boolean(),
        }),
      )
      .max(12),
    outputs: z
      .array(z.strictObject({ name: nameSchema, description: text(300) }))
      .min(1)
      .max(12),
    steps: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
          description: text(500),
          evidence: text(300),
        }),
      )
      .min(1)
      .max(20),
    requiredTools: z.array(toolNameSchema).max(16),
    runtimes: z.array(skillRuntimeSchema).min(1).max(5),
    maxContextTokens: z.number().int().min(100).max(200_000),
    dependencies: z
      .array(z.strictObject({ id: skillIdSchema, version: semverSchema }))
      .max(8),
    hooks: z.array(hookDeclarationSchema).max(16),
    fixtures: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/))
      .min(1)
      .max(8),
    instructionsHash: hashSchema,
  })
  .refine((m) => new Set(m.steps.map((s) => s.id)).size === m.steps.length)
  .refine((m) => new Set(m.hooks.map((h) => h.id)).size === m.hooks.length)
  .refine((m) => !m.dependencies.some((d) => d.id === m.id));
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export const skillPinSchema = z.strictObject({
  id: skillIdSchema,
  version: semverSchema,
  hash: hashSchema,
});
export type SkillPin = z.infer<typeof skillPinSchema>;
