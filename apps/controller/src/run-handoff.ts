import type { WorkGraphRecord } from '../../../packages/storage/src/work-graphs.ts';
import type { RootPhase, RootState } from './orchestrator.ts';

const next: Record<RootPhase, string> = {
  planning: 'Check the controller for planning progress.',
  running: 'Check worker status before resuming any work.',
  verifying: 'Check for the host verification results.',
  reviewing: 'Check for the reviewer verdict.',
  ready:
    'Inspect the integration revision and checks before deciding whether to accept.',
  accepted:
    'Check the destination checkout for the accepted revision before deciding whether to merge.',
  needs_attention:
    'Reconcile the recorded blocker and worker outcomes before retrying.',
  failed: 'Inspect the recorded failure and checks before planning a repair.',
  cancelled:
    'Confirm worker shutdown and inspect partial work before restarting.',
};

/** Operator-facing snapshot assembled exclusively from one persisted graph revision. */
export function runHandoff({
  id,
  rowVersion,
  projectId,
  state,
}: WorkGraphRecord<RootState>) {
  return {
    id,
    rowVersion,
    projectId,
    repository: state.repository ?? null,
    objective: state.objective,
    acceptanceCriteria: state.acceptanceCriteria,
    phase: state.phase,
    reason: state.reason ?? null,
    nodes: Object.values(state.nodes).map(
      ({ node, status, route, attempts, lastFailure }) => ({
        id: node.id,
        title: node.title,
        status,
        dependsOn: node.dependsOn,
        writablePaths: node.writablePaths,
        worker: route?.alias ?? null,
        lastAttempt: attempts.at(-1)?.taskId ?? null,
        lastFailure: lastFailure ?? null,
      }),
    ),
    integration: state.integration,
    checks: state.checks,
    review: state.review,
    next: next[state.phase],
  };
}
