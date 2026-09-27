import {
  DomainError,
  parse,
  workerSchema,
  idSchema,
  runRequestSchema,
  eventSchema,
  workInputSchema,
} from '../../../packages/contracts/src/index.ts';
import type {
  RuntimeAdapter,
  Worker,
  CreateTask,
  Task,
  Attempt,
  Scenario,
  Evidence,
  RuntimeEvent,
  Receipt,
} from '../../../packages/contracts/src/index.ts';
import {
  createTask,
  transitionTask,
  reviseTask,
  createAttempt,
  transitionAttempt,
} from '../../../packages/core/src/task.ts';

type Check = (task: Readonly<Task>) => Promise<boolean>;
type Terminal = Exclude<RuntimeEvent, { kind: 'started' | 'output' }>;
export class Controller {
  readonly #adapter: RuntimeAdapter;
  readonly #checks: Map<string, Check>;
  readonly #tasks = new Map<string, Task>();
  readonly #workers = new Map<string, Worker>();
  readonly #attempts = new Map<string, Attempt>();
  readonly #evidence = new Map<string, Evidence>();
  readonly #busy = new Set<string>();
  constructor(adapter: RuntimeAdapter, checks: Record<string, Check>) {
    if (adapter.runtimeKind !== 'simulated')
      throw new DomainError(
        'INVALID_INPUT',
        'Phase 1 supports simulation only',
      );
    this.#adapter = adapter;
    this.#checks = new Map(Object.entries(checks));
    for (const [id, check] of this.#checks) {
      parse(idSchema, id);
      if (typeof check !== 'function')
        throw new DomainError('INVALID_INPUT', 'Invalid verifier');
    }
  }
  registerWorker(input: Worker): void {
    const worker = parse(workerSchema, input);
    for (const existing of this.#workers.values()) {
      if (
        existing.id === worker.id ||
        existing.alias === worker.alias ||
        (existing.hostId === worker.hostId &&
          existing.runtimeKind === worker.runtimeKind &&
          existing.nativeSessionId === worker.nativeSessionId)
      )
        throw new DomainError(
          'DUPLICATE_IDENTITY',
          'Worker identity is already registered',
        );
    }
    this.#workers.set(worker.id, worker);
  }
  #checkAvailability(ids: readonly string[]): void {
    if (ids.some((id) => !this.#checks.has(id)))
      throw new DomainError(
        'INVALID_INPUT',
        'Required verifier is unavailable',
      );
  }
  #save(task: Task): Task {
    this.#tasks.set(task.id, task);
    return structuredClone(task);
  }
  create(input: CreateTask): Task {
    const task = createTask(input);
    if (this.#tasks.has(task.id))
      throw new DomainError('DUPLICATE_IDENTITY', 'Task already exists');
    this.#checkAvailability(task.requiredCheckIds);
    return this.#save(task);
  }
  getTask(id: string): Task {
    const task = this.#tasks.get(id);
    if (!task) throw new DomainError('NOT_FOUND', 'Task does not exist');
    return structuredClone(task);
  }
  getAttempt(id: string): Attempt {
    const attempt = this.#attempts.get(id);
    if (!attempt) throw new DomainError('NOT_FOUND', 'Attempt does not exist');
    return structuredClone(attempt);
  }
  queue(id: string): Task {
    return this.#save(transitionTask(this.getTask(id), 'queued'));
  }
  accept(id: string): Task {
    return this.#save(
      transitionTask(this.getTask(id), 'accepted', this.#evidence.get(id)),
    );
  }
  revise(id: string, input: unknown): Task {
    const work = parse(workInputSchema, input);
    this.#checkAvailability(work.requiredCheckIds);
    const task = reviseTask(this.getTask(id), work);
    this.#evidence.delete(id);
    return this.#save(task);
  }
  #moveAttempt(id: string, state: Attempt['state']): void {
    this.#attempts.set(id, transitionAttempt(this.getAttempt(id), state));
  }
  async #consume(
    request: Parameters<RuntimeAdapter['run']>[0],
    signal?: AbortSignal,
  ): Promise<Terminal> {
    let sequence = 0;
    let started = false;
    let terminal: Terminal | undefined;
    for await (const value of this.#adapter.run(
      structuredClone(request),
      signal,
    )) {
      const parsed = eventSchema.safeParse(value);
      if (!parsed.success)
        throw new DomainError('INVALID_EVENT', 'Malformed runtime event');
      const event = parsed.data;
      if (
        ++sequence > 256 ||
        terminal ||
        event.sequence !== sequence ||
        event.taskId !== request.taskId ||
        event.attemptId !== request.attemptId ||
        event.workerId !== request.workerId
      )
        throw new DomainError(
          'INVALID_EVENT',
          'Event stream violates ordering or identity',
        );
      if (event.kind === 'started') {
        if (started)
          throw new DomainError('INVALID_EVENT', 'Duplicate start event');
        started = true;
        this.#moveAttempt(request.attemptId, 'running');
      } else if (event.kind === 'cancelled') {
        terminal = event;
      } else {
        if (!started)
          throw new DomainError(
            'INVALID_EVENT',
            'Event preceded start acknowledgement',
          );
        if (event.kind !== 'output') terminal = event;
      }
    }
    if (!terminal)
      throw new DomainError(
        'INVALID_EVENT',
        'Stream ended without terminal evidence',
      );
    return terminal;
  }
  async run(
    taskId: string,
    workerId: string,
    attemptId: string,
    scenario: Scenario,
    signal?: AbortSignal,
  ): Promise<Task> {
    const request = parse(runRequestSchema, {
      taskId,
      workerId,
      attemptId,
      scenario,
    });
    const task = this.getTask(taskId);
    if (!this.#workers.has(workerId))
      throw new DomainError('NOT_FOUND', 'Worker does not exist');
    if (this.#busy.has(workerId))
      throw new DomainError('WORKER_BUSY', 'Worker already has an active turn');
    if (this.#attempts.has(attemptId))
      throw new DomainError('DUPLICATE_IDENTITY', 'Attempt already exists');
    // Validate before mutating any registry. No await occurs before both locks are established.
    const running = transitionTask({ ...task, attemptId }, 'running');
    const attempt = transitionAttempt(
      createAttempt(attemptId, taskId, workerId),
      'dispatching',
    );
    this.#busy.add(workerId);
    this.#attempts.set(attemptId, attempt);
    this.#save(running);
    this.#evidence.delete(taskId);
    try {
      let terminal: Terminal;
      try {
        terminal = await this.#consume(request, signal);
      } catch {
        this.#moveAttempt(attemptId, 'unknown');
        return this.#save(
          transitionTask(this.getTask(taskId), 'needs_attention'),
        );
      }
      if (terminal.kind === 'cancelled') {
        if (this.getAttempt(attemptId).state === 'running')
          this.#moveAttempt(attemptId, 'interrupt_requested');
        this.#moveAttempt(attemptId, 'cancelled');
        return this.#save(
          transitionTask(
            transitionTask(this.getTask(taskId), 'cancelling'),
            'cancelled',
          ),
        );
      }
      if (terminal.kind !== 'completed') {
        this.#moveAttempt(
          attemptId,
          terminal.kind === 'unknown' ? 'unknown' : 'failed',
        );
        return this.#save(
          transitionTask(this.getTask(taskId), 'needs_attention'),
        );
      }
      this.#moveAttempt(attemptId, 'succeeded');
      const verifying = transitionTask(
        {
          ...this.getTask(taskId),
          treeHash: terminal.treeHash,
          artifactSetHash: terminal.artifactSetHash,
        },
        'verifying',
      );
      this.#save(verifying);
      const binding = {
        taskId,
        attemptId,
        workRevision: verifying.workRevision,
        treeHash: terminal.treeHash,
        artifactSetHash: terminal.artifactSetHash,
      };
      const receipts: Receipt[] = [];
      try {
        for (const checkId of verifying.requiredCheckIds) {
          const passed = await this.#checks.get(checkId)!(
            structuredClone(verifying),
          );
          if (typeof passed !== 'boolean')
            throw new DomainError(
              'VERIFICATION_FAILED',
              'Verifier returned an invalid result',
            );
          receipts.push({
            ...binding,
            checkId,
            status: passed ? 'passed' : 'failed',
          });
        }
      } catch {
        return this.#save(
          transitionTask(this.getTask(taskId), 'needs_attention'),
        );
      }
      if (signal?.aborted)
        return this.#save(
          transitionTask(
            transitionTask(this.getTask(taskId), 'cancelling'),
            'cancelled',
          ),
        );
      if (receipts.some((receipt) => receipt.status === 'failed'))
        return this.#save(transitionTask(this.getTask(taskId), 'needs_rework'));
      const evidence: Evidence = {
        ...binding,
        runtimeKind: 'simulated',
        receipts,
      };
      const ready = transitionTask(
        this.getTask(taskId),
        'ready_for_acceptance',
        evidence,
      );
      this.#evidence.set(taskId, evidence);
      return this.#save(ready);
    } finally {
      this.#busy.delete(workerId);
    }
  }
}
