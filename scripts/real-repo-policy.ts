/** What `git` says about a repository's own checkout. */
export interface Checkout {
  head: string;
  branch: string;
  status: string;
}
/** The parts of a finished root task the receipt judges. */
export interface RunFacts {
  phase: string;
  reason?: string | null;
  checks: readonly { id: string; status: string }[];
  review?: { approve: boolean; findings: readonly string[] } | null;
  integration?: { baseCommit: string; head: string } | null;
}

/**
 * Why a real-repository run does not count, or nothing if it does. It
 * counts only if the result is ready, at least one registered check ran and
 * all passed, the review approved, the result changes something, and
 * neither the repository's checkout nor this source tree changed.
 */
export function realRepoProblems(input: {
  run: RunFacts | null;
  before: Checkout;
  after: Checkout;
  sourceBefore: string;
  sourceAfter: string;
}): string[] {
  const problems: string[] = [];
  const run = input.run;
  if (!run) problems.push('The run recorded no root task');
  else {
    if (run.phase !== 'ready')
      problems.push(
        'The run ended ' + run.phase + ': ' + (run.reason ?? 'no detail'),
      );
    if (!run.checks.length)
      problems.push('No registered check ran on the combined result');
    for (const check of run.checks)
      if (check.status !== 'passed')
        problems.push('Check ' + check.id + ' ' + check.status);
    if (!run.review?.approve)
      problems.push(
        'The review did not approve: ' +
          (run.review?.findings.join('; ') || 'no review'),
      );
    if (!run.integration || run.integration.head === run.integration.baseCommit)
      problems.push('The result changes nothing');
  }
  if (JSON.stringify(input.after) !== JSON.stringify(input.before))
    problems.push("The repository's own checkout changed during the run");
  if (input.sourceAfter !== input.sourceBefore)
    problems.push('Source changed during the run');
  return problems;
}
