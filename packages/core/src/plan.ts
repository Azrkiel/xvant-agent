import { z } from 'zod';
import { DomainError, idSchema } from '../../contracts/src/index.ts';
import { relativePathSchema } from '../../contracts/src/context.ts';
import { validateGraph } from './graph.ts';

const text = z.string().trim().min(1).max(4000);
/** A worker may be named by `@alias` or by a runtime preference. */
export const assigneeSchema = z.union([
  z.string().regex(/^@[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  z.enum(['codex', 'claude', 'opencode', 'native-local', 'any']),
]);
export const planNodeSchema = z.strictObject({
  id: idSchema,
  title: z.string().trim().min(1).max(120),
  objective: text,
  acceptanceCriteria: z.array(text).min(1).max(12),
  dependsOn: z.array(idSchema).max(19).default([]),
  role: z.enum(['worker', 'reviewer']).default('worker'),
  assignee: assigneeSchema.default('any'),
  /**
   * How strong a worker the node needs. `light` is small, mechanical work a
   * cheaper model can do; absent means `standard`.
   */
  tier: z.enum(['light', 'standard']).optional(),
  /** Paths this node may change. Empty means "anything the objective needs". */
  writablePaths: z.array(relativePathSchema).max(64).default([]),
});
export type PlanNode = z.infer<typeof planNodeSchema>;
export const planSchema = z.strictObject({
  summary: z.string().trim().min(1).max(2000),
  nodes: z.array(planNodeSchema).min(1).max(20),
});
export type Plan = z.infer<typeof planSchema>;
/** A plan as written, before defaults are filled in. */
export type PlanInput = z.input<typeof planSchema>;

export interface PlanLimits {
  maxNodes: number;
}
/**
 * Validate a proposed plan deterministically: schema, unique IDs, known
 * dependencies, no cycles, the node limit, and no two concurrent writers
 * claiming the same path. Returns nodes in dependency order.
 */
export function validatePlan(
  input: unknown,
  limits: PlanLimits = { maxNodes: 20 },
): { plan: Plan; order: string[] } {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError('GRAPH_INVALID', 'Plan does not match the contract');
  const plan = parsed.data;
  if (plan.nodes.length > limits.maxNodes)
    throw new DomainError('LIMIT_EXCEEDED', 'Plan has too many nodes');
  const order = [
    ...validateGraph(
      plan.nodes.map((node) => ({ id: node.id, dependsOn: node.dependsOn })),
      { maxNodes: Math.min(limits.maxNodes, 20), maxHierarchyDepth: 3 },
    ),
  ];
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...byId.get(id)!.dependsOn);
    }
    return false;
  };
  const writers = plan.nodes.filter((node) => node.role === 'worker');
  for (let i = 0; i < writers.length; i++)
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i]!,
        b = writers[j]!;
      // Ordered nodes integrate one after the other; only parallel writers can collide.
      if (reaches(a.id, b.id) || reaches(b.id, a.id)) continue;
      const overlap = a.writablePaths.some((p) =>
        b.writablePaths.some(
          (q) => p === q || p.startsWith(q + '/') || q.startsWith(p + '/'),
        ),
      );
      const unscoped = !a.writablePaths.length || !b.writablePaths.length;
      if (overlap || unscoped)
        throw new DomainError(
          'CONFLICT',
          `Parallel nodes ${a.id} and ${b.id} may write the same paths; scope them or order them`,
        );
    }
  return { plan, order };
}

/** Extract the last fenced JSON block (or bare JSON object) from a worker reply. */
export function extractJson(reply: string): unknown {
  const fenced = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidate = fenced.length
    ? fenced.at(-1)![1]!
    : reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new DomainError('INVALID_INPUT', 'Reply contains no JSON plan');
  }
}

/** The planning prompt. The planner proposes; the host validates and decides. */
export function planningPrompt(input: {
  objective: string;
  acceptanceCriteria: readonly string[];
  workers: readonly {
    alias: string;
    runtimeKind: string;
    roles?: readonly string[];
    tier?: 'light' | 'standard';
    model?: string;
  }[];
  repositorySummary: string;
  maxNodes: number;
}): string {
  // Tiers are mentioned only to a pool that has both, so other pools plan as before.
  const implementers = input.workers.filter(
    (w) => !w.roles || w.roles.includes('worker'),
  );
  const tiered =
    implementers.some((w) => w.tier === 'light') &&
    implementers.some((w) => w.tier !== 'light');
  return [
    'You are the planner for an XVANT task. Do not change any files.',
    '',
    '## Objective',
    input.objective,
    '',
    '## Acceptance criteria',
    ...input.acceptanceCriteria.map((c) => '- ' + c),
    '',
    '## Available workers',
    ...input.workers.map(
      (w) =>
        '- @' +
        w.alias +
        ' (' +
        w.runtimeKind +
        (w.roles?.length ? '; ' + w.roles.join(', ') : '') +
        (tiered && w.roles?.includes('worker')
          ? '; ' +
            (w.tier ?? 'standard') +
            ' tier' +
            (w.model ? ' on ' + w.model : '')
          : '') +
        ')',
    ),
    'Assign implementation only to workers with the worker role. Leave assignee as any unless a specific worker is needed.',
    ...(tiered
      ? [
          'Give each task a "tier". Use "light" for small, mechanical work with little to decide: a rename, a config or text change, boilerplate, a simple test or script that follows an existing pattern. Use "standard" for anything that needs design, debugging, or changes across several files that must agree. Light tasks run on a cheaper, weaker model, so when unsure choose "standard", and give a light task exact file names and expected results.',
        ]
      : []),
    '',
    '## Repository',
    input.repositorySummary,
    '',
    '## Instructions',
    'Split the objective into tasks that can each be done and verified on their own. Parts that change different files should be separate tasks so different workers can run them in parallel; follow any split the objective asks for. Use a single task only when the work cannot be separated.',
    'Tasks that can run in parallel must list disjoint writablePaths. Order tasks that touch the same files with dependsOn.',
    'Every task must change files. Do not add tasks that only read, explore or analyse; a task with empty writablePaths may write anywhere, so it cannot run beside another task.',
    `Use at most ${input.maxNodes} tasks. Each task needs concrete acceptance criteria a reviewer can check.`,
    'Reply with one fenced json block matching:',
    '```json',
    JSON.stringify(
      {
        summary: 'one paragraph',
        nodes: [
          {
            id: 'api',
            title: 'short title',
            objective: 'what to do',
            acceptanceCriteria: ['observable result'],
            dependsOn: [],
            role: 'worker',
            assignee: 'any',
            writablePaths: ['src/api'],
          },
        ],
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
}
