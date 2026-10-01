import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { NativeVerification } from '../../../packages/contracts/src/native-evidence.ts';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { captureWorkspace } from '../../../packages/storage/src/workspace.ts';
import { captureGitWorkspace } from '../../../packages/storage/src/git-workspace.ts';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import { redactSecrets } from '../../../packages/context/src/secrets.ts';

/** Characters of failing-check output kept for repair prompts. */
const OUTPUT_TAIL = 4000;

interface Check {
  executable: string;
  args: readonly string[];
}
/** Host-owned offline verification; no provider-supplied checks, paths or receipts. */
export class NativeVerifier {
  private readonly store: Store;
  private readonly objects: ArtifactStore;
  private readonly workspaces: Readonly<Record<string, string>>;
  private readonly checks: Readonly<Record<string, Check>>;
  private readonly timeout: number;
  private readonly gitBases: Readonly<Record<string, string>>;
  private readonly maxCheckOutput: number;
  private readonly supervisor = new WorkerSupervisor();
  private readonly failures = new Map<string, Record<string, string>>();
  private stopped = false;
  constructor(
    store: Store,
    objects: ArtifactStore,
    workspaces: Record<string, string>,
    checks: Record<string, Check>,
    options: {
      timeoutMs?: number;
      /** Workspaces that are Git worktrees, with the base commit their evidence is a patch against. */
      gitBases?: Record<string, string>;
      /** Bytes of check output allowed before verification is uncertain. */
      maxCheckOutputBytes?: number;
    } = {},
  ) {
    this.store = store;
    this.objects = objects;
    this.workspaces = structuredClone(workspaces);
    this.checks = structuredClone(checks);
    this.timeout = options.timeoutMs ?? 10000;
    this.gitBases = structuredClone(options.gitBases ?? {});
    this.maxCheckOutput = options.maxCheckOutputBytes ?? 65536;
    // Real test suites need minutes; the bound stays finite.
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 3_600_000 ||
      !Number.isSafeInteger(this.maxCheckOutput) ||
      this.maxCheckOutput < 1 ||
      this.maxCheckOutput > 16_777_216
    )
      throw new Error('INVALID_INPUT');
  }
  async verify(
    id: string,
    token: string,
    shutdown: { stopped: boolean },
  ): Promise<NativeVerification> {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    if (shutdown.stopped !== true) throw new Error('SHUTDOWN_UNCONFIRMED');
    const pending = this.store.providers.get(id);
    const root = this.workspaces[pending.workspaceId];
    if (!Object.hasOwn(this.workspaces, pending.workspaceId) || !root)
      throw new Error('WORKSPACE_UNAVAILABLE');
    const task = this.store.getTask(pending.taskId);
    if (
      task.requiredCheckIds.some(
        (check) =>
          !Object.hasOwn(this.checks, check) ||
          !isAbsolute(this.checks[check]!.executable),
      )
    )
      throw new Error('VERIFIER_UNAVAILABLE');
    const connection = this.store.providers.beginVerification(id, token);
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat();
      } catch {
        this.stop();
      }
    }, this.store.heartbeatIntervalMs);
    heartbeat.unref();
    let verification: NativeVerification;
    try {
      const base = Object.hasOwn(this.gitBases, pending.workspaceId)
        ? this.gitBases[pending.workspaceId]
        : undefined;
      const capture = () =>
        base
          ? captureGitWorkspace(root, base, this.objects)
          : captureWorkspace(root, this.objects);
      const before = capture();
      const binding = {
        taskId: task.id,
        attemptId: connection.attemptId,
        connectionId: id,
        workRevision: connection.workRevision,
        generation: connection.generation,
        workspaceId: connection.workspaceId,
        hostId: connection.worker.hostId,
        runtimeKind: connection.worker.runtimeKind,
        classification: connection.classification,
        nativeSessionId: connection.worker.nativeSessionId,
        nativeRunId: connection.nativeRunId!,
        treeHash: before.treeHash,
        artifactSetHash: before.artifactSetHash,
        workspaceRootHash: before.workspaceRootHash,
      };
      const receipts = [];
      const failures: Record<string, string> = {};
      this.failures.delete(id);
      for (const checkId of task.requiredCheckIds) {
        if (this.stopped) throw new Error('VERIFIER_UNCERTAIN');
        const check = this.checks[checkId]!;
        const result = await this.supervisor.start({
          ...check,
          cwd: root,
          workerId: 'native_verifier',
          attemptId: connection.attemptId,
          generation: connection.generation,
          timeoutMs: this.timeout,
          maxOutputBytes: this.maxCheckOutput,
          userApprovedTrustedLocal: true,
        }).result;
        if (
          this.stopped ||
          result.reason !== 'exited' ||
          result.outputTruncated
        )
          throw new Error('VERIFIER_UNCERTAIN');
        if (result.exitCode !== 0) {
          const output = redactSecrets(result.stdout + result.stderr);
          failures[checkId] =
            output.length > OUTPUT_TAIL
              ? '…' + output.slice(-OUTPUT_TAIL)
              : output;
        }
        receipts.push({
          ...binding,
          checkId,
          commandHash: createHash('sha256')
            .update(
              JSON.stringify({
                executable: check.executable,
                args: check.args,
                cwd: root,
              }),
            )
            .digest('hex'),
          status:
            result.exitCode === 0 ? ('passed' as const) : ('failed' as const),
        });
        const after = capture();
        if (
          after.treeHash !== before.treeHash ||
          after.workspaceRootHash !== before.workspaceRootHash
        )
          throw new Error('WORKSPACE_CHANGED');
      }
      if (Object.keys(failures).length) this.failures.set(id, failures);
      verification = {
        status: receipts.every((receipt) => receipt.status === 'passed')
          ? 'passed'
          : 'failed',
        evidence: { ...binding, receipts },
      };
    } catch (error) {
      verification = {
        status: 'unknown',
        reason:
          error instanceof Error && error.message === 'WORKSPACE_CHANGED'
            ? 'WORKSPACE_CHANGED'
            : 'VERIFIER_UNCERTAIN',
      };
    } finally {
      clearInterval(heartbeat);
    }
    return this.store.providers.finishVerification(
      id,
      token,
      verification,
      this.objects,
    );
  }
  /**
   * Redacted output tails of the checks that failed in the latest verification
   * of a connection. Diagnostic only: never part of evidence or receipts.
   */
  checkOutput(id: string): Record<string, string> {
    return { ...this.failures.get(id) };
  }
  stop(): void {
    this.stopped = true;
    this.supervisor.stopAll();
  }
}
