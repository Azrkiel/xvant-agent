import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateGraph } from './graph.ts';
describe('dependency graph', () => {
  it('orders dependencies before consumers without mutating input', () => {
    const nodes = [
      { id: 'b', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] },
    ];
    expect(validateGraph(nodes)).toEqual(['a', 'b']);
    expect(nodes[0]!.id).toBe('b');
  });
  it.each(
    [
      [],
      [
        { id: 'a', dependsOn: [] },
        { id: 'a', dependsOn: [] },
      ],
      [{ id: 'a', dependsOn: ['missing'] }],
      [{ id: 'a', dependsOn: ['a'] }],
      [
        { id: 'a', dependsOn: ['b', 'b'] },
        { id: 'b', dependsOn: [] },
      ],
      [
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
      ],
      [{ id: 'a', dependsOn: [], parentId: 'missing' }],
      [{ id: 'a', dependsOn: [], parentId: 'a' }],
      [
        { id: 'a', dependsOn: [], parentId: 'b' },
        { id: 'b', dependsOn: [], parentId: 'a' },
      ],
      [{ id: '../a', dependsOn: [] }],
    ].map((nodes) => ({ nodes })),
  )('rejects invalid graph %#', ({ nodes }) =>
    expect(() => validateGraph(nodes)).toThrow(),
  );
  it('accepts three hierarchy levels and rejects four', () => {
    const n = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [], parentId: 'a' },
      { id: 'c', dependsOn: [], parentId: 'b' },
    ];
    expect(validateGraph(n)).toHaveLength(3);
    expect(() =>
      validateGraph([...n, { id: 'd', dependsOn: [], parentId: 'c' }]),
    ).toThrowError(/LIMIT_EXCEEDED/);
  });
  it('accepts twenty nodes and rejects twenty-one', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      id: 'n' + i,
      dependsOn: i ? ['n' + (i - 1)] : [],
    }));
    expect(validateGraph(nodes)).toHaveLength(20);
    expect(() =>
      validateGraph([...nodes, { id: 'n20', dependsOn: [] }]),
    ).toThrowError(/LIMIT_EXCEEDED/);
  });
  it.each([
    { maxNodes: 0, maxHierarchyDepth: 3 },
    { maxNodes: 20, maxHierarchyDepth: 0 },
    { maxNodes: 1.5, maxHierarchyDepth: 3 },
    { maxNodes: 21, maxHierarchyDepth: 3 },
    { maxNodes: 20, maxHierarchyDepth: 4 },
  ])('rejects invalid limits %j', (limits) =>
    expect(() => validateGraph([{ id: 'a', dependsOn: [] }], limits)).toThrow(),
  );
  it('enforces caller-supplied lower bounds', () =>
    expect(() =>
      validateGraph(
        [
          { id: 'a', dependsOn: [] },
          { id: 'b', dependsOn: [] },
        ],
        { maxNodes: 1, maxHierarchyDepth: 1 },
      ),
    ).toThrow());
  it('sorts generated DAGs and rejects a cycle introduced into a chain', () =>
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
        (count, edges) => {
          const nodes = Array.from({ length: count }, (_, i) => ({
            id: 'n' + i,
            dependsOn: i && edges[i] ? ['n' + (i - 1)] : [],
          }));
          const order = validateGraph(nodes);
          for (const n of nodes)
            for (const d of n.dependsOn)
              expect(order.indexOf(d)).toBeLessThan(order.indexOf(n.id));
          const cycle = nodes.map((n, i) => ({
            ...n,
            dependsOn: ['n' + ((i + 1) % count)],
          }));
          expect(() => validateGraph(cycle)).toThrowError(/GRAPH_INVALID/);
        },
      ),
      { seed: 20260926, numRuns: 100 },
    ));
});
