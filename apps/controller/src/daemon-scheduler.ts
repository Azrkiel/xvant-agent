import type { Store } from '../../../packages/storage/src/store.ts';
import type { Job } from '../../../packages/storage/src/schedule.ts';
import { redactSecrets } from '../../../packages/context/src/secrets.ts';
import { Orchestrator, type RootState } from './orchestrator.ts';
import type { DaemonClock } from './daemon-clock.ts';
import { HttpError } from './http/app-server.ts';
import { RecoveryBlockedError } from './workflow-recovery.ts';

export const stopGraceMs = 4_000;
const safeReason = (error: unknown) =>
  error instanceof RecoveryBlockedError
    ? error.code
    : redactSecrets(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 500);

export class DaemonScheduler {
  #closing = false;
  #ready = false;
  #scheduled: NodeJS.Immediate | undefined;
  #timer: NodeJS.Timeout | undefined;
  #wakeAt: number | null = null;
  #passes = 0;
  readonly #observeSettlement:
    ((id: string, state: RootState) => void) | undefined;
  readonly #active = new Map<
    string,
    { controller: Orchestrator; pending: Promise<void> }
  >();

  readonly store: Store;
  readonly clock: DaemonClock;
  readonly slots: number;
  readonly controllerFor: (id: string) => Orchestrator;
  readonly projectFor: (id: string) => string;
  readonly onError: (error: unknown) => void;

  constructor(
    store: Store,
    clock: DaemonClock,
    slots: number,
    controllerFor: (id: string) => Orchestrator,
    projectFor: (id: string) => string,
    onError: (error: unknown) => void,
    observeSettlement?: (id: string, state: RootState) => void,
  ) {
    this.store = store;
    this.clock = clock;
    this.slots = slots;
    this.controllerFor = controllerFor;
    this.projectFor = projectFor;
    this.onError = onError;
    this.#observeSettlement = observeSettlement;
  }

  async recover(): Promise<void> {
    this.store.schedule.takeover();
    for (const id of this.store.workflows.interrupted()) {
      const job = this.store.schedule.get(id);
      try {
        await this.controllerFor(id).reconcile(id, { requireBindings: false });
      } catch (error) {
        if (job?.status === 'queued')
          this.store.schedule.settle(id, 'blocked', safeReason(error));
      }
    }
    this.#ready = true;
  }

  #unresolvedWorkers(ignore = '') {
    return this.store.workflows.interrupted().flatMap((id) => {
      if (id === ignore || this.#active.has(id)) return [];
      return this.store.workflows
        .actions(id)
        .filter(
          (action) =>
            action.kind === 'turn' &&
            action.status === 'dispatching' &&
            (this.store.workflows.dispatch(id, action)?.armed ?? true),
        );
    }).length;
  }

  #wait(job: Job, freeSlots: number): { reason: string } | undefined {
    for (const resource of job.resources) {
      if (
        resource.startsWith('worker:') &&
        this.store.legacyResourceOccupied(resource)
      )
        return { reason: 'PROVIDER_RESERVED' };
      if (
        resource.startsWith('quota:') &&
        this.store.providers.blocked(resource.slice(6))
      )
        return { reason: 'QUOTA_GROUP_BLOCKED' };
      if (this.store.workflows.occupied(resource, undefined, job.id))
        return { reason: 'RECONCILIATION_REQUIRED' };
    }
    for (const id of this.store.workflows.interrupted()) {
      if (id === job.id || this.#active.has(id)) continue;
      try {
        if (
          (this.store.schedule.get(id)?.project ?? this.projectFor(id)) ===
          job.project
        )
          return { reason: 'PROJECT_RECONCILIATION_REQUIRED' };
      } catch {
        // A missing checkout cannot supply a project identity. Resource
        // conflicts remain covered by the persisted A03 reservation.
      }
    }
    if (job.slots + this.#unresolvedWorkers(job.id) > freeSlots)
      return { reason: 'WORKER_LIMIT_RECONCILIATION' };
    return undefined;
  }

  pulse(): void {
    this.store.heartbeat();
    for (const { controller } of this.#active.values())
      controller.checkDeadlines();
    if (this.#wakeAt !== null && this.clock.now() >= this.#wakeAt) this.wake();
  }

  wake(): void {
    if (!this.#ready || this.#closing || this.#scheduled) return;
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined;
      try {
        this.#pump();
      } catch (error) {
        this.onError(error);
      }
    });
  }

  #pump(): void {
    this.#passes++;
    clearTimeout(this.#timer);
    this.#wakeAt = null;
    if (this.#closing || !this.store.schedule.control().dispatch) return;
    const start = this.clock.now();
    for (;;) {
      const job = this.store.schedule.claim(
        this.slots,
        (candidate, freeSlots) => this.#wait(candidate, freeSlots),
      );
      if (!job) break;
      this.#run(job);
    }
    const now = this.clock.now();
    this.#wakeAt = this.store.schedule.wakeAt(start);
    if (this.#wakeAt !== null)
      this.#timer = setTimeout(
        () => this.wake(),
        Math.min(2_147_483_647, Math.max(1, this.#wakeAt - now)),
      );
  }

  #run(job: Job): void {
    let controller: Orchestrator;
    try {
      controller = this.controllerFor(job.id);
    } catch (error) {
      this.store.schedule.settle(
        job.id,
        'blocked',
        safeReason(error),
        job.claim!,
      );
      return;
    }
    if (job.cancelRequested) controller.cancel();
    const run = async () => {
      let state: RootState;
      try {
        state = await controller.resume(job.id);
      } catch (error) {
        if (!this.#closing || safeReason(error) !== 'CONTROLLER_SUSPENDED')
          this.store.schedule.settle(
            job.id,
            'blocked',
            safeReason(error),
            job.claim!,
          );
        return;
      }
      const checkpoint = Orchestrator.checkpoint(this.store, job.id);
      const unresolved = this.store.workflows
        .actions(job.id)
        .some(({ status }) => status === 'dispatching');
      const status =
        unresolved || checkpoint.progress.step !== 'done'
          ? 'blocked'
          : state.phase === 'cancelled'
            ? 'cancelled'
            : 'done';
      this.store.workflows.atomic(() => {
        this.store.schedule.settle(
          job.id,
          status,
          state.reason ?? null,
          job.claim!,
        );
        if (status === 'done') this.#observeSettlement?.(job.id, state);
      });
    };
    const pending = run()
      .catch(this.onError)
      .finally(() => {
        this.#active.delete(job.id);
        this.wake();
      });
    this.#active.set(job.id, { controller, pending });
  }

  cancel(id: string): void {
    const job = this.store.schedule.get(id);
    if (!job) throw new HttpError(404, 'NOT_FOUND');
    this.store.schedule.requestCancel(id);
    if (job.status !== 'queued' && job.status !== 'blocked') return;
    if (
      this.store.workflows
        .actions(id)
        .some(({ status }) => status === 'dispatching')
    )
      return;
    Orchestrator.cancelPrepared(this.store, id);
    this.store.schedule.settle(id, 'cancelled', 'CANCELLED');
  }

  signalCancellation(id: string): void {
    if (this.store.schedule.get(id)?.cancelRequested)
      this.#active.get(id)?.controller.cancel();
    this.wake();
  }

  status() {
    const now = this.clock.now();
    const jobs = this.store.schedule.pending();
    const control = this.store.schedule.control();
    return {
      ...this.store.ownership,
      ready: this.#ready && !this.#closing,
      control,
      drained: !!control.draining && this.#active.size === 0,
      schedulerPasses: this.#passes,
      workerSlots: {
        limit: this.slots,
        unresolved: this.#unresolvedWorkers(),
        reserved: jobs
          .filter((j) => j.status === 'running')
          .reduce((n, j) => n + j.slots, 0),
      },
      interrupted: this.store.workflows
        .interrupted()
        .filter((id) => !this.#active.has(id)),
      jobs: jobs.map((job) => ({
        ...job,
        reason:
          job.reason ??
          (job.status === 'queued' && !control.dispatch
            ? 'DISPATCH_PAUSED'
            : null),
        queueLagMs:
          job.status === 'queued' ? Math.max(0, now - job.dueAt) : null,
        progressAgeMs: Math.max(0, now - job.updatedAt),
      })),
    };
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#timer);
    clearImmediate(this.#scheduled);
    const pending = Promise.allSettled(
      [...this.#active.values()].map((work) => work.pending),
    );
    const suspend = setTimeout(() => {
      for (const { controller } of this.#active.values()) controller.suspend();
    }, stopGraceMs);
    try {
      await pending;
    } finally {
      clearTimeout(suspend);
    }
  }
}
