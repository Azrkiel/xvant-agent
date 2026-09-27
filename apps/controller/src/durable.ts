import { fileURLToPath } from 'node:url';
import type { Task, Receipt } from '../../../packages/contracts/src/index.ts';
import { Store, StorageError } from '../../../packages/storage/src/store.ts';
import type { Dispatch } from '../../../packages/storage/src/store.ts';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
export interface ProcessCheck {
  executable: string;
  args: readonly string[];
  cwd: string;
}
export class DurableController {
  readonly #store: Store;
  readonly #checks: Readonly<Record<string, ProcessCheck>>;
  readonly #supervisor = new WorkerSupervisor();
  readonly #timeout: number;
  readonly #workerScript: string;
  readonly #heartbeat: ReturnType<typeof setInterval>;
  #stopped = false;
  readonly #active = new Map<string, Promise<Task>>();
  constructor(
    store: Store,
    checks: Record<string, ProcessCheck>,
    options: { timeoutMs?: number; workerScript?: string } = {},
  ) {
    this.#store = store;
    this.#checks = structuredClone(checks);
    this.#timeout = options.timeoutMs ?? 10000;
    this.#workerScript =
      options.workerScript ??
      fileURLToPath(new URL('./simulated-worker.ts', import.meta.url));
    this.#heartbeat = setInterval(() => {
      try {
        this.#store.heartbeat();
      } catch {
        this.stop();
      }
    }, store.heartbeatIntervalMs);
    this.#heartbeat.unref();
  }
  async run(key: string, spec: Dispatch): Promise<Task> {
    if (this.#stopped) throw new StorageError('CONTROLLER_STOPPED');
    const task = this.#store.getTask(spec.taskId);
    if (task.requiredCheckIds.some((id) => !Object.hasOwn(this.#checks, id)))
      throw new StorageError('VERIFIER_UNAVAILABLE');
    const op = this.#store.dispatch(key, spec);
    const active = this.#active.get(op.attemptId);
    if (active) return active;
    if (this.#store.getOperation(op.attemptId).status !== 'prepared')
      return this.#store.getTask(op.taskId);
    this.#store.markSending(op.attemptId, op.token);
    const run = this.#execute(op).finally(() =>
      this.#active.delete(op.attemptId),
    );
    this.#active.set(op.attemptId, run);
    return run;
  }
  async #execute(op: ReturnType<Store['getOperation']>): Promise<Task> {
    try {
      const { taskId, attemptId, workerId, scenario } = op;
      const result = await this.#supervisor.start({
        executable: process.execPath,
        args: [
          this.#workerScript,
          JSON.stringify({
            request: { taskId, attemptId, workerId, scenario },
            token: op.token,
            generation: op.generation,
          }),
        ],
        cwd: process.cwd(),
        workerId,
        attemptId,
        generation: op.generation,
        timeoutMs: this.#timeout,
        maxOutputBytes: 1024 * 1024,
        userApprovedTrustedLocal: true,
      }).result;
      if (
        result.reason !== 'exited' ||
        result.exitCode !== 0 ||
        result.outputTruncated
      ) {
        this.#store.fail(attemptId, op.token, 'unknown');
        return this.#store.getTask(taskId);
      }
      try {
        const lines = result.stdout.trim().split('\n');
        for (const line of lines) {
          const envelope: unknown = JSON.parse(line);
          if (
            !envelope ||
            typeof envelope !== 'object' ||
            !('token' in envelope) ||
            envelope.token !== op.token ||
            !('generation' in envelope) ||
            envelope.generation !== op.generation ||
            !('event' in envelope)
          )
            throw new StorageError('INVALID_EVENT');
          this.#store.receive(attemptId, op.token, envelope.event);
        }
      } catch {
        const current = this.#store.getOperation(attemptId);
        if (['sending', 'running'].includes(current.status))
          this.#store.fail(attemptId, op.token, 'invalid_event');
        else if (
          current.status === 'completed' &&
          this.#store.getTask(taskId).state === 'verifying'
        )
          this.#store.finishVerification(taskId, undefined);
        return this.#store.getTask(taskId);
      }
      if (this.#store.getOperation(attemptId).status !== 'completed') {
        if (
          ['sending', 'running'].includes(
            this.#store.getOperation(attemptId).status,
          )
        )
          this.#store.fail(attemptId, op.token, 'unknown');
        return this.#store.getTask(taskId);
      }
      const verifying = this.#store.getTask(taskId);
      const binding = {
        taskId,
        attemptId,
        workRevision: verifying.workRevision,
        treeHash: verifying.treeHash!,
        artifactSetHash: verifying.artifactSetHash!,
      };
      const receipts: Receipt[] = [];
      for (const checkId of verifying.requiredCheckIds) {
        if (this.#stopped)
          return this.#store.finishVerification(taskId, undefined);
        const check = this.#checks[checkId]!;
        const checked = await this.#supervisor.start({
          ...check,
          workerId: 'verifier',
          attemptId,
          generation: op.generation,
          timeoutMs: this.#timeout,
          maxOutputBytes: 65536,
          userApprovedTrustedLocal: true,
        }).result;
        if (checked.reason !== 'exited' || checked.outputTruncated)
          return this.#store.finishVerification(taskId, undefined);
        receipts.push({
          ...binding,
          checkId,
          status: checked.exitCode === 0 ? 'passed' : 'failed',
        });
      }
      return this.#store.finishVerification(
        taskId,
        { ...binding, runtimeKind: 'simulated', receipts },
        receipts.some((r) => r.status === 'failed'),
      );
    } catch (error) {
      const task = this.#store.getTask(op.taskId);
      if (task.state === 'verifying')
        return this.#store.finishVerification(op.taskId, undefined);
      if (
        ['sending', 'running'].includes(
          this.#store.getOperation(op.attemptId).status,
        )
      ) {
        this.#store.fail(op.attemptId, op.token, 'unknown');
        return this.#store.getTask(op.taskId);
      }
      throw error;
    }
  }
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    this.#supervisor.stopAll();
  }
}
