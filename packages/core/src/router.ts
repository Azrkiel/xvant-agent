import type { PlanNode } from './plan.ts';

export interface RoutableWorker {
  alias: string;
  runtimeKind: 'codex' | 'claude' | 'opencode';
  quotaGroupId: string;
  busy: boolean;
  healthy: boolean;
  blocked: boolean;
  /** Node IDs this worker completed in the current root task. */
  completed: readonly string[];
  /** Roles this worker is configured for. */
  roles: readonly ('worker' | 'reviewer')[];
}
export interface RouteDecision {
  alias: string | null;
  reasons: string[];
  excluded: { alias: string; reason: string }[];
}

/**
 * Explainable routing. An explicit `@alias` wins when that worker can take
 * the node; otherwise filter by role, health, account block and runtime
 * preference, prefer a worker that completed a dependency (its session holds
 * the context), then a reviewer on a runtime that wrote none of the work,
 * then the least recently loaded worker. Nothing here changes billing: an
 * unavailable preference waits instead of falling back to another account.
 */
export function routeNode(
  node: Pick<PlanNode, 'id' | 'role' | 'assignee' | 'dependsOn'>,
  workers: readonly RoutableWorker[],
  context: { implementerRuntimes?: readonly string[] } = {},
): RouteDecision {
  const excluded: RouteDecision['excluded'] = [];
  const exclude = (alias: string, reason: string) =>
    excluded.push({ alias, reason });
  if (node.assignee.startsWith('@')) {
    const alias = node.assignee.slice(1);
    const worker = workers.find(
      (w) => w.alias.toLowerCase() === alias.toLowerCase(),
    );
    if (!worker)
      return {
        alias: null,
        reasons: ['Assigned worker ' + node.assignee + ' is not registered'],
        excluded,
      };
    const blocker = !worker.healthy
      ? 'unhealthy'
      : worker.blocked
        ? 'account blocked'
        : worker.busy
          ? 'busy'
          : null;
    if (blocker)
      return {
        alias: null,
        reasons: ['Waiting for ' + node.assignee + ' (' + blocker + ')'],
        excluded,
      };
    return {
      alias: worker.alias,
      reasons: ['Explicitly assigned ' + node.assignee],
      excluded,
    };
  }
  const eligible = workers.filter((w) => {
    if (!w.roles.includes(node.role))
      return (exclude(w.alias, 'role ' + node.role + ' not configured'), false);
    if (!w.healthy) return (exclude(w.alias, 'unhealthy'), false);
    if (w.blocked) return (exclude(w.alias, 'account blocked'), false);
    if (node.assignee !== 'any' && w.runtimeKind !== node.assignee)
      return (exclude(w.alias, 'runtime is not ' + node.assignee), false);
    if (w.busy) return (exclude(w.alias, 'busy'), false);
    return true;
  });
  if (!eligible.length)
    return {
      alias: null,
      reasons: ['No eligible worker is idle; waiting'],
      excluded,
    };
  const score = (w: RoutableWorker) => {
    let s = 0;
    if (node.dependsOn.some((d) => w.completed.includes(d))) s += 4;
    if (
      node.role === 'reviewer' &&
      !context.implementerRuntimes?.includes(w.runtimeKind)
    )
      s += 8;
    // Keep reviewers free of implementation when a plain worker can take it,
    // so an independent review stays possible.
    if (node.role === 'worker' && w.roles.includes('reviewer')) s -= 1;
    s -= w.completed.length * 0.01;
    return s;
  };
  const ranked = [...eligible].sort(
    (a, b) => score(b) - score(a) || (a.alias < b.alias ? -1 : 1),
  );
  const chosen = ranked[0]!;
  const reasons = ['Idle and eligible for role ' + node.role];
  if (node.dependsOn.some((d) => chosen.completed.includes(d)))
    reasons.push('Continues its own dependency work');
  if (
    node.role === 'reviewer' &&
    !context.implementerRuntimes?.includes(chosen.runtimeKind)
  )
    reasons.push('Independent runtime for review');
  return { alias: chosen.alias, reasons, excluded };
}
