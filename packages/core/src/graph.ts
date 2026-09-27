import { z } from 'zod';
import { DomainError, idSchema } from '../../contracts/src/index.ts';
export interface GraphNode {
  id: string;
  dependsOn: readonly string[];
  parentId?: string;
}
const nodeSchema = z.strictObject({
  id: idSchema,
  dependsOn: z.array(idSchema).max(20),
  parentId: idSchema.optional(),
});
const limitsSchema = z.strictObject({
  maxNodes: z.number().int().min(1).max(20),
  maxHierarchyDepth: z.number().int().min(1).max(3),
});
export function validateGraph(
  input: readonly GraphNode[],
  settings = { maxNodes: 20, maxHierarchyDepth: 3 },
): readonly string[] {
  const limits = limitsSchema.safeParse(settings);
  if (!limits.success)
    throw new DomainError('GRAPH_INVALID', 'Invalid graph limits');
  if (Array.isArray(input) && input.length > limits.data.maxNodes)
    throw new DomainError('LIMIT_EXCEEDED', 'Too many graph nodes');
  const result = z.array(nodeSchema).min(1).max(20).safeParse(input);
  if (!result.success)
    throw new DomainError('GRAPH_INVALID', 'Invalid graph node contract');
  const nodes = result.data;
  const index = new Map(nodes.map((n) => [n.id, n]));
  if (index.size !== nodes.length)
    throw new DomainError('GRAPH_INVALID', 'Duplicate task identifier');
  for (const node of nodes) {
    if (
      new Set(node.dependsOn).size !== node.dependsOn.length ||
      node.dependsOn.some((id) => id === node.id || !index.has(id))
    )
      throw new DomainError('GRAPH_INVALID', 'Invalid dependency reference');
    if (
      node.parentId !== undefined &&
      (node.parentId === node.id || !index.has(node.parentId))
    )
      throw new DomainError('GRAPH_INVALID', 'Invalid parent reference');
  }
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new DomainError('GRAPH_INVALID', 'Dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of index.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  for (const node of nodes) visit(node.id);
  for (const node of nodes) {
    const ancestors = new Set([node.id]);
    let cursor = node;
    while (cursor.parentId !== undefined) {
      if (ancestors.has(cursor.parentId))
        throw new DomainError('GRAPH_INVALID', 'Parent cycle');
      ancestors.add(cursor.parentId);
      if (ancestors.size > limits.data.maxHierarchyDepth)
        throw new DomainError('LIMIT_EXCEEDED', 'Hierarchy is too deep');
      cursor = index.get(cursor.parentId)!;
    }
  }
  return ordered;
}
