import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  providerWorkerSchema,
  qualificationSchema,
  providerBindingSchema,
  providerEventSchema,
  usageSampleSchema,
} from '../../../contracts/src/providers.ts';
import type {
  ProviderWorker,
  ProviderBinding,
} from '../../../contracts/src/providers.ts';

/** Advisory only: evidence must come from a trusted host probe, never a worker.
 * This module has no transport and cannot enable live execution. */
export function negotiate(
  workerInput: unknown,
  evidence: unknown,
): { enabled: boolean; code?: string } {
  const worker = providerWorkerSchema.parse(workerInput);
  const result = qualificationSchema.safeParse(evidence);
  if (!result.success || result.data.classification !== 'live')
    return { enabled: false, code: 'CAPABILITY_UNSUPPORTED' };
  const q = result.data;
  if (
    q.runtimeKind !== worker.runtimeKind ||
    q.runtimeVersion !== worker.runtimeVersion ||
    q.adapterVersion !== worker.adapterVersion ||
    q.hostId !== worker.hostId ||
    q.endpointId !== worker.endpointId ||
    q.quotaGroupId !== worker.quotaGroupId
  )
    return { enabled: false, code: 'VERSION_UNSUPPORTED' };
  if (q.auth !== 'passed') return { enabled: false, code: 'AUTH_REQUIRED' };
  if (q.billing !== 'subscription')
    return { enabled: false, code: 'BILLING_UNVERIFIED' };
  if (
    !['run', 'cancel', 'reconcile'].every((c) =>
      q.capabilities.some((v) => v === c),
    )
  )
    return { enabled: false, code: 'CAPABILITY_UNSUPPORTED' };
  return { enabled: true };
}

type Active = {
  binding: ProviderBinding;
  sequence: number;
  hashes: Map<number, string>;
  terminal: boolean;
  status:
    'running' | 'interrupt_requested' | 'needs_attention' | 'result_pending';
};
type Entry = { worker: ProviderWorker; generation: number; active?: Active };
function fail(code: string): never {
  throw new Error(code);
}
function sameBinding(a: ProviderBinding, b: ProviderBinding) {
  return (
    a.taskId === b.taskId &&
    a.attemptId === b.attemptId &&
    a.generation === b.generation &&
    a.nativeRunId === b.nativeRunId
  );
}
/** In-memory offline routing contract. Durable integration is deliberately separate. */
export class ProviderRegistry {
  private readonly entries = new Map<string, Entry>();
  register(input: unknown): void {
    const worker = providerWorkerSchema.parse(input);
    for (const { worker: other } of this.entries.values()) {
      if (
        worker.id === other.id ||
        worker.alias.toLowerCase() === other.alias.toLowerCase() ||
        (worker.runtimeKind === other.runtimeKind &&
          worker.hostId === other.hostId &&
          worker.nativeSessionId === other.nativeSessionId)
      )
        fail('DUPLICATE_IDENTITY');
    }
    this.entries.set(worker.id, { worker, generation: 0 });
  }
  list(): ProviderWorker[] {
    return [...this.entries.values()].map(({ worker }) => ({ ...worker }));
  }
  status(id: string): Active['status'] | 'idle' {
    return this.entry(id).active?.status ?? 'idle';
  }
  resolve(alias: string): ProviderWorker {
    const name = alias.replace(/^@/, '').toLowerCase();
    const found = this.list().find((w) => w.alias.toLowerCase() === name);
    return found ?? fail('NOT_FOUND');
  }
  private entry(id: string): Entry {
    return this.entries.get(id) ?? fail('NOT_FOUND');
  }
  private current(id: string, input: unknown): Active {
    const binding = providerBindingSchema.parse(input);
    const active = this.entry(id).active;
    if (!active || !sameBinding(active.binding, binding))
      fail('STALE_EVIDENCE');
    return active;
  }
  begin(id: string, input: unknown): void {
    const binding = providerBindingSchema.parse(input);
    const entry = this.entry(id);
    if (entry.worker.mode !== 'managed') fail('CAPABILITY_UNSUPPORTED');
    if (entry.active) fail('WORKER_BUSY');
    if (binding.generation <= entry.generation) fail('STALE_EVIDENCE');
    entry.generation = binding.generation;
    entry.active = {
      binding,
      sequence: 0,
      hashes: new Map(),
      terminal: false,
      status: 'running',
    };
  }
  cancel(id: string, input: unknown) {
    const active = this.current(id, input);
    // Requesting interruption does not prove that any process stopped.
    if (active.status === 'running') active.status = 'interrupt_requested';
    return {
      ...active.binding,
      workerId: id,
      nativeSessionId: this.entry(id).worker.nativeSessionId,
    };
  }
  disconnected(id: string, input: unknown): void {
    this.current(id, input).status = 'needs_attention';
  }
  receive(id: string, input: unknown): 'recorded' | 'duplicate' {
    const event = providerEventSchema.parse(input);
    const active = this.current(id, {
      taskId: event.taskId,
      attemptId: event.attemptId,
      generation: event.generation,
      nativeRunId: event.nativeRunId,
    });
    const worker = this.entry(id).worker;
    if (
      event.workerId !== id ||
      event.runtimeKind !== worker.runtimeKind ||
      event.nativeSessionId !== worker.nativeSessionId
    )
      fail('INVALID_EVENT');
    const hash = createHash('sha256')
      .update(JSON.stringify(event))
      .digest('hex');
    const previous = active.hashes.get(event.sequence);
    if (previous) {
      if (previous !== hash) fail('INVALID_EVENT');
      return 'duplicate';
    }
    if (
      active.terminal ||
      event.sequence !== active.sequence + 1 ||
      active.sequence >= 4096
    )
      fail('INVALID_EVENT');
    active.sequence = event.sequence;
    active.hashes.set(event.sequence, hash);
    active.terminal = event.kind !== 'output';
    if (event.kind === 'failed' && event.code === 'OPERATION_UNKNOWN')
      active.status = 'needs_attention';
    else if (active.terminal && active.status === 'running')
      active.status = 'result_pending';
    return 'recorded';
  }
  /** Trusted controller calls only after verification and confirmed stopped/not-started execution. */
  reconcile(
    id: string,
    input: unknown,
    outcome: 'stopped' | 'not_started',
  ): void {
    z.enum(['stopped', 'not_started']).parse(outcome);
    this.current(id, input);
    delete this.entry(id).active;
  }
}

export function summarizeUsage(input: unknown) {
  const samples = z.array(usageSampleSchema).max(10000).parse(input);
  const groups = new Map<
    string,
    {
      quotaGroupId: string;
      measuredTokens: number;
      estimatedTokens: number;
      unknownSamples: number;
    }
  >();
  for (const sample of samples) {
    const group = groups.get(sample.quotaGroupId) ?? {
      quotaGroupId: sample.quotaGroupId,
      measuredTokens: 0,
      estimatedTokens: 0,
      unknownSamples: 0,
    };
    if (sample.kind === 'unknown') group.unknownSamples++;
    else if (sample.kind === 'measured') group.measuredTokens += sample.tokens;
    else group.estimatedTokens += sample.tokens;
    if (
      !Number.isSafeInteger(group.measuredTokens) ||
      !Number.isSafeInteger(group.estimatedTokens)
    )
      fail('LIMIT_EXCEEDED');
    groups.set(sample.quotaGroupId, group);
  }
  return [...groups.values()];
}
