import type { Store } from '../../../packages/storage/src/store.ts';
import type {
  LessonNode,
  SolutionNode,
} from '../../../packages/contracts/src/lessons.ts';
import {
  lessonReport,
  lessonsToMermaid,
  renderReport,
} from '../../../packages/memory/src/lessons.ts';

/** Most challenges one response carries, newest first. */
export const LESSON_VIEW_CHALLENGES = 200;
/** Longest diff excerpt sent per solution. */
const DIFF_EXCERPT = 1500;

const excerpt = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) + '\n[truncated]' : text;
const when = (node: LessonNode) =>
  node.kind === 'challenge' ? node.lastSeenAt : node.createdAt;

function solutionView(
  node: SolutionNode,
  relation: 'solved_by' | 'not_solved_by',
  count: number,
) {
  return {
    id: node.id,
    relation,
    count,
    summary: node.summary,
    files: node.files,
    verified: node.checks.length > 0,
    checks: node.checks,
    usage: node.usage,
    diff: excerpt(node.diff, DIFF_EXCERPT),
    diffTruncated: node.diff.length > DIFF_EXCERPT,
  };
}

/**
 * One scope's lessons for the browser. Forgotten nodes are left out. Every
 * string comes from worker or tool output and is untrusted: the client must
 * show it as text.
 */
export function lessonsView(store: Store, scope: string) {
  const nodes = store.lessons.nodes(scope).filter((n) => !n.forgotten);
  const kept = new Set(nodes.map((n) => n.id));
  const edges = store.lessons
    .edges(scope)
    .filter((e) => kept.has(e.from) && kept.has(e.to));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const challenges = nodes
    .filter((n) => n.kind === 'challenge')
    .sort((a, b) => when(b) - when(a));
  const shown = challenges.slice(0, LESSON_VIEW_CHALLENGES).map((c) => {
    const solutions = edges
      .filter(
        (e) =>
          e.from === c.id &&
          (e.relation === 'solved_by' || e.relation === 'not_solved_by'),
      )
      .flatMap((e) => {
        const solution = byId.get(e.to);
        return solution?.kind === 'solution' &&
          (e.relation === 'solved_by' || e.relation === 'not_solved_by')
          ? [solutionView(solution, e.relation, e.count)]
          : [];
      });
    return {
      id: c.id,
      title: c.title,
      occurrences: c.occurrences,
      source: c.source,
      files: c.files,
      lastSeenAt: c.lastSeenAt,
      fixes: solutions.filter((s) => s.relation === 'solved_by').length,
      deadEnds: solutions.filter((s) => s.relation === 'not_solved_by').length,
      solutions,
    };
  });
  // The same report as `xvant lessons stats`, from every stored node.
  const report = lessonReport(
    store.graphs.lessonSummaries(scope, 200).map((r) => r.lessons),
    store.lessons.nodes(scope),
    store.lessons.edges(scope),
    200,
  );
  return {
    challenges: shown,
    totalChallenges: challenges.length,
    stats: { report, text: renderReport(scope, report) },
    mermaid: lessonsToMermaid(nodes, edges),
  };
}
