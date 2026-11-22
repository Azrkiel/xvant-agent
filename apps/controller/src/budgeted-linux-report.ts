import { z } from 'zod';
import { DomainError } from '../../../packages/contracts/src/index.ts';
import type { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import type { Store } from '../../../packages/storage/src/store.ts';
import type { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import {
  startLinuxOfflineWorker,
  type LinuxOfflineRequest,
} from '../../../packages/supervisor/src/linux-offline-worker.ts';
import {
  validateWorkerReport,
  workerReportBinding,
} from '../../../packages/supervisor/src/worker-artifact.ts';

/** Trusted internal entry point for a staged offline report. Callers supply the
 * task, staged input digest and runtime image/profile digest they authorized. */
export async function runBudgetedLinuxReport(
  store: Store,
  objects: ArtifactStore,
  supervisor: WorkerSupervisor,
  taskId: string,
  input: z.infer<typeof workerReportBinding>,
  request: LinuxOfflineRequest & {
    limits: NonNullable<LinuxOfflineRequest['limits']>;
  },
) {
  const binding = workerReportBinding.parse(input);
  const { task } = store.contracts.getTask(taskId).record;
  if (
    task.type !== 'scout' ||
    request.operatorApproved !== true ||
    (request.profile && request.profile !== 'offline')
  )
    throw new DomainError(
      'POLICY_DENIED',
      'Use an authorized scout task and the offline report profile',
    );
  if (
    request.generation !== store.ownership.generation ||
    request.attemptId !== binding.actionId
  )
    throw new DomainError(
      'CONFLICT',
      'Report dispatch identity differs from the authorized operation',
    );
  const budget = { wallTimeMs: request.timeoutMs, tokens: 0, costMicros: 0 };
  store.budgets.reserveForDispatch(binding.actionId, taskId, budget);
  const started = performance.now();
  let result;
  let identity;
  try {
    const handle = startLinuxOfflineWorker(supervisor, request);
    identity = handle.identity;
    result = await handle.result;
  } catch (error) {
    store.budgets.settle(binding.actionId, null);
    throw error;
  }
  if (result.reason === 'needs_attention' || result.reason === 'spawn_failed') {
    store.budgets.settle(binding.actionId, null);
    throw new Error(
      'RECONCILIATION_REQUIRED: could not establish the worker outcome',
    );
  }
  // The owned launcher has ended and the cgroup path proved empty. There
  // is no provider or billable usage in this profile.
  store.budgets.settle(binding.actionId, {
    ...budget,
    wallTimeMs: Math.ceil(performance.now() - started),
  });
  const report = validateWorkerReport(result, identity, binding);
  if (objects.put(report.bytes) !== report.receipt.sha256)
    throw new Error('INVALID_WORKER_ARTIFACT: receipt hash mismatch');
  return report.receipt;
}
