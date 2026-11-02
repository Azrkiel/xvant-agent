import type { Store } from '../../../packages/storage/src/store.ts';
import type {
  LessonMatch,
  LessonRelation,
  LessonSource,
  RunLessonStats,
  SolutionInput,
} from '../../../packages/contracts/src/lessons.ts';
import { renderLessons } from '../../../packages/memory/src/lessons.ts';

export type LessonStats = RunLessonStats;

/**
 * One run's view of the lesson graph. Learning is an aid, never a reason
 * for a run to fail: every call that throws is counted and skipped.
 */
export class RunLessons {
  readonly stats: LessonStats & {
    repairs: NonNullable<LessonStats['repairs']>;
  } = {
    challenges: 0,
    solutions: 0,
    hinted: 0,
    errors: 0,
    repairs: {
      hinted: { passed: 0, failed: 0 },
      unhinted: { passed: 0, failed: 0 },
    },
  };
  readonly #store: Store | null;
  readonly #projectId: string;
  readonly #graphId: string;
  /** Repairs recorded without checks this run, as sent, to verify later. */
  #unverified: SolutionInput[] = [];
  constructor(store: Store | null, projectId: string, graphId: string) {
    this.#store = store;
    this.#projectId = projectId;
    this.#graphId = graphId;
    // A run with lessons off has no scope and records no repairs.
    if (store) this.stats.scope = projectId;
  }
  #try<T>(fn: (store: Store) => T): T | undefined {
    if (!this.#store) return undefined;
    try {
      return fn(this.#store);
    } catch {
      this.stats.errors++;
      return undefined;
    }
  }
  /** Records a challenge occurrence and returns its id. */
  challenge(input: {
    failure: string;
    source: LessonSource;
    context?: string;
    files?: string[];
    taskId?: string;
  }): string | undefined {
    return this.#try((store) => {
      const node = store.lessons.recordChallenge({
        projectId: this.#projectId,
        failure: input.failure.slice(0, 200_000),
        source: input.source,
        ...(input.context ? { context: input.context.slice(0, 4000) } : {}),
        files: (input.files ?? []).slice(0, 64),
        provenance: {
          graphId: this.#graphId,
          ...(input.taskId && input.taskId !== 'none'
            ? { taskId: input.taskId }
            : {}),
        },
      });
      this.stats.challenges++;
      return node.id;
    });
  }
  /** Records what a worker changed against `challengeIds` and how it went. */
  resolve(
    challengeIds: readonly string[],
    relation: Exclude<LessonRelation, 'followed_by'>,
    change: {
      summary: string;
      files: string[];
      diff: string;
      checks: string[];
      taskId?: string;
      alias?: string;
    },
  ): void {
    // A turn that changed nothing taught nothing about how to fix it.
    if (!challengeIds.length || (!change.files.length && !change.diff.trim()))
      return;
    this.#try((store) => {
      const input: SolutionInput = {
        projectId: this.#projectId,
        summary: change.summary.slice(0, 200_000),
        files: change.files.slice(0, 64),
        diff: change.diff.slice(0, 10_000_000),
        checks: change.checks.slice(0, 32),
        provenance: {
          graphId: this.#graphId,
          ...(change.taskId ? { taskId: change.taskId } : {}),
          ...(change.alias ? { alias: change.alias.slice(0, 64) } : {}),
        },
      };
      const solution = store.lessons.recordSolution(input);
      if (relation === 'solved_by' && !input.checks.length)
        this.#unverified.push(input);
      for (const id of new Set(challengeIds)) {
        store.lessons.link(this.#projectId, id, solution.id, relation);
        this.stats.solutions++;
      }
    });
  }
  /**
   * Marks the repairs of this run that were recorded without checks as
   * verified by `passed`, the checks that just passed on the combined result.
   * The same input arrives again, so the graph merges the check ids into the
   * solution it already holds.
   */
  verify(passed: readonly string[]): void {
    const checks = passed.slice(0, 32);
    if (!checks.length || !this.#unverified.length) return;
    const pending = this.#unverified;
    this.#unverified = [];
    for (const input of pending)
      this.#try((store) => {
        store.lessons.recordSolution({ ...input, checks: [...checks] });
      });
  }
  followedBy(from: string | undefined, to: string | undefined): void {
    if (!from || !to || from === to) return;
    this.#try((store) =>
      store.lessons.link(this.#projectId, from, to, 'followed_by'),
    );
  }
  /**
   * Counts one repair turn whose outcome was judged, by whether its prompt
   * carried lessons. Callers skip turns that say nothing about the repair
   * (unknown, cancelled, runtime failure, operator stop, no verdict).
   */
  repair(hinted: boolean, passed: boolean): void {
    if (!this.#store) return;
    this.stats.repairs[hinted ? 'hinted' : 'unhinted'][
      passed ? 'passed' : 'failed'
    ]++;
  }
  /** Tells the graph whether the repair that was shown `suggested` succeeded. */
  usage(suggested: readonly string[] | undefined, succeeded: boolean): void {
    if (!suggested?.length) return;
    this.#try((store) =>
      store.lessons.recordUsage(this.#projectId, suggested, succeeded),
    );
  }
  /**
   * A prompt section with what the graph knows about each failure in
   * `queries`, and the ids of the solutions it shows.
   */
  hints(queries: string | readonly string[]): {
    text: string;
    suggested: string[];
  } {
    const list = (typeof queries === 'string' ? [queries] : queries).filter(
      (query) => query.trim(),
    );
    if (!list.length) return { text: '', suggested: [] };
    const found = this.#try((store) => {
      const seen = new Map<string, LessonMatch>();
      for (const query of list.slice(0, 20))
        for (const match of store.lessons.find(this.#projectId, {
          query: query.slice(0, 20_000),
          limit: 3,
        }))
          if (!seen.has(match.challenge.id))
            seen.set(match.challenge.id, match);
      const matches = [...seen.values()]
        .sort((a, b) => Number(b.exact) - Number(a.exact))
        .slice(0, 3);
      const text = renderLessons(matches);
      return {
        text,
        // Only what made it into the text, which is cut to a size budget.
        suggested: matches
          .filter((m) => text.includes('### ' + m.challenge.id + ':'))
          .flatMap((m) => m.solutions.map((s) => s.solution.id)),
      };
    });
    if (found?.text) this.stats.hinted++;
    return found ?? { text: '', suggested: [] };
  }
}
