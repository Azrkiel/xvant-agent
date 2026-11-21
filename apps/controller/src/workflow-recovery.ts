import { join } from 'node:path';
import type { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { IntegrationBranch } from '../../../packages/storage/src/integration.ts';
import type { Store } from '../../../packages/storage/src/store.ts';
import type {
  DispatchingAction,
  RecoveryDecision,
  RecoveryProbe,
  WorkDispatch,
  WorkerProcessIdentity,
} from '../../../packages/storage/src/workflows.ts';
import { probeProcess } from '../../../packages/supervisor/src/process-identity.ts';
import { redactSecrets } from '../../../packages/context/src/secrets.ts';
import type { RootState, TurnOutcome, TurnRequest } from './orchestrator.ts';
import {
  applyIntentSchema,
  checkedResultSchema,
  checkIntentSchema,
  integrationIdentitySchema,
  turnIntentSchema,
  turnResultSchema,
  type WorkflowCheckpoint,
} from './workflow-checkpoint.ts';

export interface TurnCorrelation {
  operationId: string;
  attemptId: string;
}
export interface TurnExecution extends TurnCorrelation {
  onProcess: (process: WorkerProcessIdentity) => void;
}
interface RemoteReceipt extends TurnCorrelation {
  outcome: TurnOutcome;
}
/** The host adapter supplies verified receipts bound to this service and attempt. */
export interface RemoteTurnRecovery {
  identity: string;
  /** Operations in this service scope conflict until their effects are settled. */
  scope: string;
  lookup?: (
    key: TurnCorrelation,
    signal: AbortSignal,
  ) => Promise<RemoteReceipt | null>;
  /**
   * Atomically return the original result or execute once under the original
   * key. The original run must use the same conditional protocol. The
   * guarantee covers racing requests and outlives the original deadline.
   */
  replay?: (
    key: TurnCorrelation,
    request: TurnRequest,
    signal: AbortSignal,
  ) => Promise<RemoteReceipt | null>;
}

export function remoteRecoveryBinding(remote: RemoteTurnRecovery): string {
  return JSON.stringify([
    remote.identity,
    remote.scope,
    !!remote.lookup,
    !!remote.replay,
  ]);
}

export class RecoveryBlockedError extends Error {
  readonly code = 'UNRESOLVED_WORKFLOW_ACTION';
  readonly recovery: RecoveryDecision[];
  constructor(recovery: RecoveryDecision[]) {
    super(
      recovery
        .map(
          (entry) =>
            'UNRESOLVED_WORKFLOW_ACTION: ' +
            entry.slot +
            ' (' +
            entry.attemptId +
            ') — ' +
            entry.detail +
            (entry.operatorAction ? ' ' + entry.operatorAction : ''),
        )
        .join('\n'),
    );
    this.recovery = recovery;
  }
}

export function captureTurn(objects: ArtifactStore, outcome: TurnOutcome) {
  const { patch, failure, finalText, ...observed } = outcome;
  return turnResultSchema.parse({
    ...observed,
    finalText: redactSecrets(finalText),
    ...(failure === undefined ? {} : { failure: redactSecrets(failure) }),
    patchHash: patch === null ? null : objects.put(patch),
  });
}

const PROBE_MS = 2_000;
async function bounded<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          reject(new Error('PROBE_TIMEOUT'));
          abort.abort();
        }, ms);
      }),
      run(abort.signal),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

const errorCode = (error: unknown) => {
  const code =
    (error as NodeJS.ErrnoException | null)?.code ??
    (error as Error | null)?.message?.split(':', 1)[0];
  return typeof code === 'string' && /^[A-Z][A-Z_]{2,64}$/.test(code)
    ? code
    : 'EVIDENCE_UNAVAILABLE';
};

export async function recoverWorkflowAction(
  store: Store,
  objects: ArtifactStore,
  checkpoint: WorkflowCheckpoint,
  integration: RootState['integration'],
  action: DispatchingAction,
  remote: RemoteTurnRecovery | undefined,
  now: () => number = Date.now,
  allowReplay = true,
): Promise<RecoveryDecision> {
  const { id, repository, baseRevision } = checkpoint.spec;
  const workflows = store.workflows;
  const dispatch = workflows.dispatch(id, action);
  const settle = (probe: RecoveryProbe, result?: unknown) =>
    workflows.reconcile(id, action, dispatch, probe, result);
  const block = (
    source: string,
    evidence: RecoveryProbe['evidence'],
    detail: string,
    operatorAction: string,
  ) =>
    settle({
      classification: 'unresolved',
      source,
      evidence,
      detail,
      operatorAction,
    });
  if (!dispatch)
    return block(
      'legacy_action',
      { generation: action.generation },
      'This dispatch predates the recovery journal and has no bound effect receipt.',
      'Preserve the checkout and inspect the original attempt before taking action.',
    );
  if (!dispatch.armed)
    return settle({
      classification: 'not_started',
      source: 'sqlite_dispatch',
      evidence: { armed: false },
      detail: 'The owner never recorded permission to start the effect.',
    });

  if (action.kind === 'initialize' || action.kind === 'apply') {
    // Keep the probe and decision inside the ownership transaction. Git cannot
    // move a ref here, and a stale controller cannot acquire the writer lock.
    return workflows.atomic(() => {
      const target =
        action.kind === 'initialize'
          ? integrationIdentitySchema.parse(action.input)
          : integration;
      if (
        !target ||
        target.baseCommit !== baseRevision ||
        target.path !== join(checkpoint.stateRoot, id, 'integration') ||
        target.branch !== 'xvant/' + id
      )
        throw new Error('CHECKPOINT_INVALID');
      const input =
        action.kind === 'apply' ? applyIntentSchema.parse(action.input) : null;
      const proof = () => {
        const checkout = IntegrationBranch.inspect(
          repository,
          target.path,
          target.branch,
          target.baseCommit,
          action.kind === 'initialize' ? dispatch.id : undefined,
        );
        if (!input) {
          if (checkout.head() !== baseRevision || target.head !== baseRevision)
            throw new Error('INTEGRATION_CHANGED');
          return {
            result: target,
            head: baseRevision,
            tree: null,
            patchHash: null,
          };
        }
        if (input.before !== target.head) throw new Error('CHECKPOINT_INVALID');
        let patch: Buffer = Buffer.alloc(0);
        if (input.patchHash) {
          try {
            patch = objects.get(input.patchHash);
          } catch (error) {
            if (errorCode(error) === 'ENOENT')
              throw new Error('ARTIFACT_MISSING');
            throw error;
          }
        }
        const { result, tree } = checkout.recoverApply(
          input.before,
          patch,
          input.message,
          dispatch.id,
        );
        return {
          result,
          head: result.commit,
          tree,
          patchHash: input.patchHash,
        };
      };
      let observed: ReturnType<typeof proof>;
      try {
        observed = proof();
      } catch (error) {
        const code = errorCode(error);
        return block(
          'git',
          {
            code,
            path: target.path,
            branch: target.branch,
            expectedHead: target.head,
            patchHash: input?.patchHash ?? null,
          },
          'Git could not establish the intended result (' + code + ').',
          code === 'ARTIFACT_MISSING' || code === 'ARTIFACT_CORRUPT'
            ? 'Restore the patch object from a trusted backup, then resume.'
            : 'Inspect the recorded worktree, parent and patch while preserving local files.',
        );
      }
      return settle(
        {
          classification: 'completed_verifiable',
          source: 'git',
          evidence: {
            path: target.path,
            repository,
            branch: target.branch,
            parent: target.head,
            head: observed.head,
            tree: observed.tree,
            patchHash: observed.patchHash,
          },
          detail:
            'The repository, registered worktree and result match the journal.',
        },
        observed.result,
      );
    });
  }

  if (dispatch.observation !== undefined) {
    let complete:
      | ReturnType<typeof turnResultSchema.parse>
      | ReturnType<typeof checkedResultSchema.parse>;
    try {
      if (action.kind === 'check') {
        complete = checkedResultSchema.parse(dispatch.observation);
        if (complete.id !== checkIntentSchema.parse(action.input).id)
          throw new Error('STALE_EVIDENCE');
      } else {
        complete = turnResultSchema.parse(dispatch.observation);
        if (complete.status === 'unknown') throw new Error('STALE_EVIDENCE');
        if (complete.patchHash) objects.get(complete.patchHash);
      }
    } catch (error) {
      return block(
        'host_receipt',
        { code: errorCode(error) },
        'The durable host receipt or one of its artifacts is unavailable.',
        'Restore the referenced artifact from a trusted backup, then resume.',
      );
    }
    return settle(
      {
        classification:
          complete.status === 'accepted' || complete.status === 'passed'
            ? 'completed_verifiable'
            : 'stopped_incomplete',
        source: 'host_receipt',
        evidence: {
          status: complete.status,
          patchHash: 'patchHash' in complete ? complete.patchHash : null,
        },
        detail:
          'The original host recorded a terminal observation before the acknowledgment.',
      },
      complete,
    );
  }

  const processes = dispatch.processes.map((process) => ({
    ...process,
    observed: probeProcess(process),
  }));
  const evidence: RecoveryProbe['evidence'] = {
    processes,
    operationId: dispatch.operationId,
  };
  if (action.kind === 'turn') {
    const input = turnIntentSchema.parse(action.input);
    let provider: ReturnType<Store['providers']['get']> | undefined;
    try {
      provider = store.providers.get(input.taskId);
    } catch (error) {
      if (errorCode(error) !== 'NOT_FOUND') throw error;
    }
    if (
      provider &&
      provider.taskId === input.taskId &&
      provider.workspaceId === input.taskId &&
      provider.worker.id === input.alias &&
      provider.attemptId === dispatch.attemptId &&
      provider.generation === dispatch.generation
    ) {
      evidence.provider = {
        connectionId: provider.connectionId,
        generation: provider.generation,
        status: provider.status,
        workRevision: provider.workRevision,
        outcome: provider.outcome,
        verification: provider.verification?.status ?? null,
      };
    }
    if (dispatch.adapter) {
      // Service evidence cannot release a reservation while a known child can
      // still act, or its recorded identity can no longer be established.
      if (processes.every((process) => process.observed === 'exited')) {
        if (!remote || remoteRecoveryBinding(remote) !== dispatch.adapter)
          return block(
            'remote',
            evidence,
            'The original remote adapter binding is unavailable.',
            'Restore the original adapter configuration, then resume.',
          );
        return recoverRemote(
          store,
          id,
          action,
          dispatch,
          input,
          remote,
          objects,
          now,
          allowReplay,
        );
      }
    }
  }
  if (processes.some((process) => process.observed === 'running'))
    return settle({
      classification: 'owned_running',
      source: 'linux_proc',
      evidence,
      detail: 'The original worker or check process still owns this attempt.',
      operatorAction:
        'Wait for the owned process to finish, then resume to recheck its evidence.',
    });
  if (
    processes.length &&
    processes.every((process) => process.observed === 'exited')
  )
    return settle({
      classification: 'stopped_incomplete',
      source: 'linux_proc',
      evidence,
      detail:
        'The tracked process exited without a terminal receipt. Descendants or effects may remain.',
      operatorAction:
        'Preserve the workspace and inspect the attempt and provider journal.',
    });
  return block(
    'process_and_provider_journal',
    evidence,
    'No bound terminal receipt or trustworthy worker identity establishes the outcome.',
    'Inspect the original worker environment and preserve its workspace and reservations.',
  );
}

async function recoverRemote(
  store: Store,
  id: string,
  action: DispatchingAction,
  dispatch: WorkDispatch,
  input: ReturnType<typeof turnIntentSchema.parse>,
  remote: RemoteTurnRecovery,
  objects: ArtifactStore,
  now: () => number,
  allowReplay: boolean,
): Promise<RecoveryDecision> {
  const { operationId, attemptId } = dispatch;
  const key = { operationId, attemptId };
  const evidence = {
    ...key,
    adapter: remote.identity,
    scope: remote.scope,
    lookup: !!remote.lookup,
    replay: !!remote.replay,
  };
  let source = 'remote_lookup';
  let code = 'REMOTE_LOOKUP_UNAVAILABLE';
  const accept = (receipt: RemoteReceipt | null) => {
    if (receipt === null) throw new Error('REMOTE_RECEIPT_MISSING');
    if (receipt.operationId !== operationId || receipt.attemptId !== attemptId)
      throw new Error('STALE_EVIDENCE');
    if (receipt.outcome.status === 'unknown')
      throw new Error('REMOTE_RECEIPT_INCOMPLETE');
    return captureTurn(objects, receipt.outcome);
  };
  let result: ReturnType<typeof captureTurn> | undefined;
  if (remote.lookup) {
    try {
      result = accept(
        await bounded(PROBE_MS, (signal) => remote.lookup!(key, signal)),
      );
    } catch (error) {
      code = errorCode(error);
    }
  }
  const remaining = input.deadlineAt - now();
  if (
    !result &&
    allowReplay &&
    remote.replay &&
    remaining > 0 &&
    code !== 'STALE_EVIDENCE'
  ) {
    source = 'remote_idempotent_replay';
    store.workflows.reconcile(
      id,
      action,
      dispatch,
      {
        classification: 'unresolved',
        source,
        evidence: { ...evidence, code },
        detail:
          'The bound service supports atomic replay of the original operation and attempt.',
      },
      undefined,
      true,
    );
    try {
      result = accept(
        await bounded(Math.min(PROBE_MS, remaining), (signal) =>
          remote.replay!(key, input, signal),
        ),
      );
    } catch (error) {
      code = errorCode(error);
    }
  }
  if (!result)
    return store.workflows.reconcile(id, action, dispatch, {
      classification: 'unresolved',
      source,
      evidence: { ...evidence, code, deadlineExpired: remaining <= 0 },
      detail:
        'The bound service did not supply a correlated terminal receipt (' +
        code +
        ').',
      operatorAction:
        'Check the original service operation using the recorded IDs before resuming.',
    });
  return store.workflows.reconcile(
    id,
    action,
    dispatch,
    {
      classification:
        result.status === 'accepted'
          ? 'completed_verifiable'
          : 'stopped_incomplete',
      source,
      evidence: {
        ...evidence,
        status: result.status,
        patchHash: result.patchHash,
      },
      detail:
        'The service returned a terminal receipt for the original operation and attempt.',
    },
    result,
  );
}
