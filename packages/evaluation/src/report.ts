import type { Suite } from './suite.ts';
import { attemptKey, type AttemptRecord, type Scheduled } from './runner.ts';

/** Below this many scheduled attempts per configuration, results are directional only. */
export const DIRECTIONAL_BELOW = 30;

export interface ConfigurationSummary {
  scheduled: number;
  accepted: number;
  failed: number;
  incomplete: number;
  excluded: number;
  missing: number;
  /** Accepted over every scheduled, non-excluded attempt: failed, incomplete and missing all count against it. */
  successRate: number | null;
  /** Tasks accepted in every repeat. */
  tasksAlwaysAccepted: number;
  medianElapsedMs: number | null;
  /** Null unless every finished attempt reported the figure. */
  inputTokens: number | null;
  outputTokens: number | null;
  toolFailures: number | null;
  conflicts: number | null;
  versions: Record<string, string>;
}
export interface BenchmarkReport {
  suiteId: string;
  frozenHash: string;
  /** False while any scheduled attempt has no record or is incomplete. */
  complete: boolean;
  directional: boolean;
  configurations: Record<string, ConfigurationSummary>;
  bySplit: Record<
    string,
    Record<string, { scheduled: number; accepted: number }>
  >;
  exclusions: { taskId: string; configuration: string; reason: string }[];
  missing: Scheduled[];
  limitations: string[];
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};
const total = (values: (number | null)[]) =>
  values.length && values.every((v) => v !== null)
    ? (values as number[]).reduce((a, b) => a + b, 0)
    : null;

export function summarize(
  suite: Suite,
  frozenHash: string,
  schedule: Scheduled[],
  records: AttemptRecord[],
): BenchmarkReport {
  const byKey = new Map(records.map((r) => [attemptKey(r), r]));
  const missing = schedule.filter((s) => !byKey.has(attemptKey(s)));
  const configurations: BenchmarkReport['configurations'] = {};
  const bySplit: BenchmarkReport['bySplit'] = {};
  const split = new Map(suite.tasks.map((t) => [t.id, t.split]));
  for (const name of new Set(schedule.map((s) => s.configuration))) {
    const scheduled = schedule.filter((s) => s.configuration === name);
    const mine = scheduled.flatMap((s) => byKey.get(attemptKey(s)) ?? []);
    const of = (status: AttemptRecord['status']) =>
      mine.filter((r) => r.status === status);
    const ran = mine.filter(
      (r) => r.status === 'accepted' || r.status === 'failed',
    );
    const counted = scheduled.length - of('excluded').length;
    const tasks = new Set(scheduled.map((s) => s.taskId));
    configurations[name] = {
      scheduled: scheduled.length,
      accepted: of('accepted').length,
      failed: of('failed').length,
      incomplete: of('incomplete').length,
      excluded: of('excluded').length,
      missing: scheduled.length - mine.length,
      successRate: counted ? of('accepted').length / counted : null,
      tasksAlwaysAccepted: [...tasks].filter((task) =>
        scheduled
          .filter((s) => s.taskId === task)
          .every((s) => byKey.get(attemptKey(s))?.status === 'accepted'),
      ).length,
      medianElapsedMs: median(ran.map((r) => r.elapsedMs)),
      inputTokens: total(ran.map((r) => r.usage.inputTokens)),
      outputTokens: total(ran.map((r) => r.usage.outputTokens)),
      toolFailures: total(ran.map((r) => r.toolFailures)),
      conflicts: total(ran.map((r) => r.conflicts)),
      versions: mine[0]?.versions ?? {},
    };
    for (const s of scheduled) {
      const cell = ((bySplit[split.get(s.taskId) ?? 'unknown'] ??= {})[name] ??=
        { scheduled: 0, accepted: 0 });
      cell.scheduled += 1;
      if (byKey.get(attemptKey(s))?.status === 'accepted') cell.accepted += 1;
    }
  }
  const summaries = Object.values(configurations);
  const directional = summaries.some((c) => c.scheduled < DIRECTIONAL_BELOW);
  const limitations: string[] = [];
  if (directional)
    limitations.push(
      'Small sample: results are directional evidence, not proof of general superiority.',
    );
  if (summaries.some((c) => c.inputTokens === null || c.outputTokens === null))
    limitations.push(
      'Token usage is unknown for at least one configuration and is not estimated; no cost is derived.',
    );
  if (missing.length || summaries.some((c) => c.incomplete))
    limitations.push(
      'The campaign is incomplete: missing and quota-interrupted attempts count against the success rate.',
    );
  limitations.push('Human rework was not measured.');
  return {
    suiteId: suite.id,
    frozenHash,
    complete: !missing.length && summaries.every((c) => !c.incomplete),
    directional,
    configurations,
    bySplit,
    exclusions: records
      .filter((r) => r.status === 'excluded')
      .map((r) => ({
        taskId: r.taskId,
        configuration: r.configuration,
        reason: r.reason ?? '',
      })),
    missing,
    limitations,
  };
}

/**
 * Promotion rules (plan §14) applied to held-out tasks only. A candidate is
 * never promoted on an incomplete campaign, on a safety regression, or with
 * fewer accepted tasks than the baseline, whatever else improved.
 */
export function evaluatePromotion(
  report: BenchmarkReport,
  options: {
    baseline: string;
    candidate: string;
    /** Mandatory safety/recovery fixtures the candidate was run against. */
    safetyFixturesPassed: boolean;
  },
): { promote: boolean; benefits: string[]; blockers: string[] } {
  const blockers: string[] = [];
  const benefits: string[] = [];
  const base = report.configurations[options.baseline];
  const candidate = report.configurations[options.candidate];
  const held = report.bySplit['held-out'];
  const heldBase = held?.[options.baseline];
  const heldCandidate = held?.[options.candidate];
  if (!base || !candidate || !heldBase || !heldCandidate)
    return {
      promote: false,
      benefits,
      blockers: ['baseline or candidate has no held-out results'],
    };
  if (!report.complete) blockers.push('campaign is incomplete');
  if (!options.safetyFixturesPassed)
    blockers.push('safety or recovery fixtures regressed');
  if (heldCandidate.accepted < heldBase.accepted)
    blockers.push(
      'accepted held-out attempts fell from ' +
        heldBase.accepted +
        ' to ' +
        heldCandidate.accepted,
    );
  if (heldCandidate.accepted > heldBase.accepted)
    benefits.push('more accepted held-out attempts');
  if (
    base.medianElapsedMs !== null &&
    candidate.medianElapsedMs !== null &&
    candidate.medianElapsedMs < base.medianElapsedMs
  )
    benefits.push('lower median elapsed time');
  const usage = (c: ConfigurationSummary) =>
    c.inputTokens !== null && c.outputTokens !== null
      ? c.inputTokens + c.outputTokens
      : null;
  const [before, after] = [usage(base), usage(candidate)];
  if (before !== null && after !== null && after < before)
    benefits.push('lower measured token usage');
  if (!benefits.length) blockers.push('no measured benefit');
  return { promote: blockers.length === 0, benefits, blockers };
}
