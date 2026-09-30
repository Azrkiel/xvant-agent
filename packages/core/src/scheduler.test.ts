import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { extractJson, planningPrompt, validatePlan } from './plan.ts';
import { routeNode, type RoutableWorker } from './router.ts';

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  objective: 'do ' + id,
  acceptanceCriteria: ['done'],
  ...over,
});
describe('plan validation', () => {
  it('orders dependencies and fills defaults', () => {
    const { plan, order } = validatePlan({
      summary: 's',
      nodes: [
        node('ui', { dependsOn: ['api'], writablePaths: ['web'] }),
        node('api', { writablePaths: ['server'] }),
      ],
    });
    expect(order).toEqual(['api', 'ui']);
    expect(plan.nodes[0]).toMatchObject({ role: 'worker', assignee: 'any' });
  });
  it('rejects cycles, unknown dependencies and oversized plans', () => {
    expect(() =>
      validatePlan({
        summary: 's',
        nodes: [
          node('a', { dependsOn: ['b'] }),
          node('b', { dependsOn: ['a'] }),
        ],
      }),
    ).toThrow('GRAPH_INVALID');
    expect(() =>
      validatePlan({ summary: 's', nodes: [node('a', { dependsOn: ['x'] })] }),
    ).toThrow('GRAPH_INVALID');
    expect(() =>
      validatePlan({
        summary: 's',
        nodes: Array.from({ length: 21 }, (_, i) => node('n' + i)),
      }),
    ).toThrow();
  });
  it('rejects parallel writers that could touch the same paths', () => {
    expect(() =>
      validatePlan({
        summary: 's',
        nodes: [
          node('a', { writablePaths: ['src'] }),
          node('b', { writablePaths: ['src/x.ts'] }),
        ],
      }),
    ).toThrow('CONFLICT');
    expect(() =>
      validatePlan({ summary: 's', nodes: [node('a'), node('b')] }),
    ).toThrow('CONFLICT');
    expect(
      validatePlan({
        summary: 's',
        nodes: [node('a'), node('b', { dependsOn: ['a'] })],
      }).order,
    ).toEqual(['a', 'b']);
  });
  it('never accepts a cyclic or oversized random graph', () =>
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.nat(24), { maxLength: 4 }), {
          minLength: 1,
          maxLength: 25,
        }),
        (edges) => {
          const nodes = edges.map((deps, i) =>
            node('n' + i, {
              dependsOn: [
                ...new Set(deps.filter((d) => d < edges.length && d !== i)),
              ].map((d) => 'n' + d),
              writablePaths: ['p' + i],
            }),
          );
          try {
            const { order } = validatePlan({ summary: 's', nodes });
            const at = new Map(order.map((id, i) => [id, i]));
            return (
              nodes.length <= 20 &&
              nodes.every((n) =>
                (n as unknown as { dependsOn: string[] }).dependsOn.every(
                  (d) => at.get(d)! < at.get(n.id)!,
                ),
              )
            );
          } catch {
            return true;
          }
        },
      ),
    ));
  it('extracts the last json block from a reply', () => {
    expect(
      extractJson('text\n```json\n{"a":1}\n```\nmore\n```json\n{"a":2}\n```'),
    ).toEqual({ a: 2 });
    expect(extractJson('Here: {"a":3} ok')).toEqual({ a: 3 });
    expect(() => extractJson('no plan')).toThrow('INVALID_INPUT');
  });
  it('asks for a plan without file changes', () =>
    expect(
      planningPrompt({
        objective: 'Build X',
        acceptanceCriteria: ['X works'],
        workers: [{ alias: 'codex-1', runtimeKind: 'codex' }],
        repositorySummary: 'r',
        maxNodes: 5,
      }),
    ).toMatch(/Do not change any files[\s\S]*@codex-1[\s\S]*at most 5 tasks/));
});

const worker = (
  alias: string,
  over: Partial<RoutableWorker> = {},
): RoutableWorker => ({
  alias,
  runtimeKind: alias.startsWith('codex')
    ? 'codex'
    : alias.startsWith('claude')
      ? 'claude'
      : 'opencode',
  quotaGroupId: 'q',
  busy: false,
  healthy: true,
  blocked: false,
  completed: [],
  roles: ['worker', 'reviewer'],
  ...over,
});
const task = (over: Record<string, unknown> = {}) => ({
  id: 't',
  role: 'worker' as const,
  assignee: 'any' as const,
  dependsOn: [] as string[],
  ...over,
});
describe('routing', () => {
  it('honours an explicit @alias and waits when it is busy', () => {
    expect(
      routeNode(task({ assignee: '@Claude-2' }), [
        worker('claude-1'),
        worker('claude-2'),
      ]).alias,
    ).toBe('claude-2');
    const waiting = routeNode(task({ assignee: '@claude-2' }), [
      worker('claude-2', { busy: true }),
    ]);
    expect(waiting.alias).toBeNull();
    expect(waiting.reasons[0]).toMatch(/busy/);
  });
  it('never routes to a blocked account or another runtime than requested', () => {
    const d = routeNode(task({ assignee: 'claude' }), [
      worker('claude-1', { blocked: true }),
      worker('codex-1'),
    ]);
    expect(d.alias).toBeNull();
    expect(d.excluded).toEqual([
      { alias: 'claude-1', reason: 'account blocked' },
      { alias: 'codex-1', reason: 'runtime is not claude' },
    ]);
  });
  it('prefers the worker that did the dependency, and independent reviewers', () => {
    expect(
      routeNode(task({ dependsOn: ['a'] }), [
        worker('codex-1'),
        worker('opencode-1', { completed: ['a'] }),
      ]).alias,
    ).toBe('opencode-1');
    expect(
      routeNode(
        task({ role: 'reviewer' }),
        [worker('codex-1'), worker('claude-1')],
        {
          implementerRuntimes: ['codex'],
        },
      ).alias,
    ).toBe('claude-1');
  });
});

describe('reviewer independence', () => {
  it('gives implementation to plain workers so a reviewer stays independent', () => {
    expect(
      routeNode(task(), [
        worker('claude-1', { roles: ['worker', 'reviewer'] }),
        worker('opencode-1', { roles: ['worker'] }),
      ]).alias,
    ).toBe('opencode-1');
  });
});

describe('review routing', () => {
  it('prefers a reviewer who implemented nothing, even on a used runtime', () => {
    const decision = routeNode(
      task({ role: 'reviewer' }),
      [
        worker('codex-1', { completed: ['api'] }),
        worker('claude-1', { completed: ['web'] }),
        worker('claude-2'),
      ],
      { implementerRuntimes: ['codex', 'claude'] },
    );
    expect(decision.alias).toBe('claude-2');
    expect(decision.reasons).toContain('Wrote none of the reviewed work');
  });
});
