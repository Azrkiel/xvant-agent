import { describe, expect, it } from 'vitest';
import { ProviderRegistry, negotiate, summarizeUsage } from './registry.ts';
import { providerWorkerSchema } from '../../../contracts/src/providers.ts';

const worker = (
  runtimeKind: 'codex' | 'claude' | 'opencode' = 'codex',
  n = 1,
) => ({
  id: `${runtimeKind}_${n}`,
  alias: `${runtimeKind}-${n}`,
  runtimeKind,
  hostId: 'local',
  endpointId: 'endpoint',
  nativeSessionId: `session/${n}:native`,
  runtimeVersion: 'fixture-1',
  adapterVersion: '1',
  mode: 'managed' as const,
  quotaGroupId: 'account',
});
const binding = {
  taskId: 'task',
  attemptId: 'attempt',
  generation: 1,
  nativeRunId: 'run/1',
};
const event = (sequence = 1, kind = 'output') => ({
  ...binding,
  workerId: 'codex_1',
  nativeSessionId: 'session/1:native',
  runtimeKind: 'codex',
  sequence,
  kind,
  text: 'fixture',
});

describe('provider conformance', () => {
  it('accepts opaque native identities separately from internal IDs', () => {
    expect(providerWorkerSchema.parse(worker()).nativeSessionId).toBe(
      'session/1:native',
    );
    expect(() =>
      providerWorkerSchema.parse({ ...worker(), id: 'bad/id' }),
    ).toThrow();
    expect(() =>
      providerWorkerSchema.parse({
        ...worker(),
        nativeSessionId: 'bad\nvalue',
      }),
    ).toThrow();
  });
  it.each(['codex', 'claude', 'opencode'] as const)(
    '%s defaults to disabled without exact live qualification',
    (kind) => {
      const w = worker(kind);
      expect(negotiate(w, undefined)).toEqual({
        enabled: false,
        code: 'CAPABILITY_UNSUPPORTED',
      });
      const evidence = {
        runtimeKind: kind,
        runtimeVersion: 'fixture-1',
        adapterVersion: '1',
        hostId: 'local',
        endpointId: 'endpoint',
        quotaGroupId: 'account',
        classification: 'offline',
        auth: 'passed',
        billing: 'subscription',
        capabilities: ['run', 'cancel', 'reconcile'],
      };
      expect(negotiate(w, evidence).enabled).toBe(false);
      expect(
        negotiate(w, { ...evidence, classification: 'live' }).enabled,
      ).toBe(true);
      expect(
        negotiate(w, {
          ...evidence,
          classification: 'live',
          runtimeVersion: 'other',
        }).code,
      ).toBe('VERSION_UNSUPPORTED');
      expect(
        negotiate(w, { ...evidence, classification: 'live', auth: 'unknown' })
          .code,
      ).toBe('AUTH_REQUIRED');
      expect(
        negotiate(w, {
          ...evidence,
          classification: 'live',
          billing: 'unknown',
        }).code,
      ).toBe('BILLING_UNVERIFIED');
      expect(
        negotiate(w, {
          ...evidence,
          classification: 'live',
          capabilities: ['run'],
        }).enabled,
      ).toBe(false);
      expect(
        negotiate(w, {
          ...evidence,
          classification: 'live',
          quotaGroupId: 'other_account',
        }).enabled,
      ).toBe(false);
    },
  );
  it('registers the full 2/3/5 roster and resolves explicit aliases', () => {
    const registry = new ProviderRegistry();
    for (const [kind, count] of [
      ['codex', 2],
      ['claude', 3],
      ['opencode', 5],
    ] as const)
      for (let n = 1; n <= count; n++) registry.register(worker(kind, n));
    expect(registry.list()).toHaveLength(10);
    expect(registry.resolve('@opencode-5').id).toBe('opencode_5');
    expect(() => registry.resolve('@missing')).toThrow('NOT_FOUND');
  });
  it('rejects duplicate workers, aliases and scoped native sessions', () => {
    const registry = new ProviderRegistry();
    registry.register(worker());
    for (const patch of [
      { id: 'other' },
      { id: 'other', alias: 'other' },
      { alias: 'other', nativeSessionId: 'new' },
    ])
      expect(() => registry.register({ ...worker(), ...patch })).toThrow(
        'DUPLICATE_IDENTITY',
      );
  });
  it('copies registration inputs and returns snapshots', () => {
    const registry = new ProviderRegistry();
    const input = worker();
    registry.register(input);
    input.alias = 'changed';
    registry.list()[0]!.alias = 'changed';
    expect(registry.resolve('@codex-1').alias).toBe('codex-1');
  });
  it('does not permit a second endpoint alias to control the same native session', () => {
    const registry = new ProviderRegistry();
    registry.register(worker());
    expect(() =>
      registry.register({
        ...worker(),
        id: 'other',
        alias: 'other',
        endpointId: 'other_endpoint',
      }),
    ).toThrow('DUPLICATE_IDENTITY');
  });
  it('routes errors and cancellation to each of ten independent sessions', () => {
    const registry = new ProviderRegistry();
    for (const [kind, count] of [
      ['codex', 2],
      ['claude', 3],
      ['opencode', 5],
    ] as const)
      for (let n = 1; n <= count; n++) registry.register(worker(kind, n));
    for (const w of registry.list()) {
      const b = {
        ...binding,
        taskId: `task_${w.id}`,
        attemptId: `attempt_${w.id}`,
        nativeRunId: `run/${w.id}`,
      };
      registry.begin(w.id, b);
      expect(registry.cancel(w.id, b).nativeSessionId).toBe(w.nativeSessionId);
      expect(
        registry.receive(w.id, {
          ...b,
          workerId: w.id,
          runtimeKind: w.runtimeKind,
          nativeSessionId: w.nativeSessionId,
          sequence: 1,
          kind: 'failed',
          code: 'QUOTA_BLOCKED',
        }),
      ).toBe('recorded');
      expect(() => registry.begin(w.id, { ...b, generation: 2 })).toThrow(
        'WORKER_BUSY',
      );
    }
  });
  it('bounds event memory and rejects unknown workers', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.begin('missing', binding)).toThrow('NOT_FOUND');
    registry.register(worker());
    registry.begin('codex_1', binding);
    for (let n = 1; n <= 4096; n++) registry.receive('codex_1', event(n));
    expect(() => registry.receive('codex_1', event(4097))).toThrow(
      'INVALID_EVENT',
    );
  });
  it.each(['attached-readonly', 'imported', 'attached-control'])(
    'blocks unqualified %s mutation',
    (mode) => {
      const registry = new ProviderRegistry();
      registry.register({ ...worker(), mode });
      expect(() => registry.begin('codex_1', binding)).toThrow(
        'CAPABILITY_UNSUPPORTED',
      );
    },
  );
  it('holds a session through cancellation and unknown outcome until trusted reconciliation', () => {
    const registry = new ProviderRegistry();
    registry.register(worker());
    registry.begin('codex_1', binding);
    expect(registry.status('codex_1')).toBe('running');
    expect(() => registry.begin('codex_1', binding)).toThrow('WORKER_BUSY');
    expect(registry.cancel('codex_1', binding)).toEqual({
      ...binding,
      workerId: 'codex_1',
      nativeSessionId: 'session/1:native',
    });
    expect(registry.status('codex_1')).toBe('interrupt_requested');
    registry.disconnected('codex_1', binding);
    expect(registry.status('codex_1')).toBe('needs_attention');
    registry.receive('codex_1', {
      ...binding,
      workerId: 'codex_1',
      runtimeKind: 'codex',
      nativeSessionId: 'session/1:native',
      sequence: 1,
      kind: 'completed',
    });
    expect(registry.status('codex_1')).toBe('needs_attention');
    expect(() =>
      registry.begin('codex_1', { ...binding, generation: 2 }),
    ).toThrow('WORKER_BUSY');
    expect(() =>
      registry.reconcile('codex_1', { ...binding, generation: 0 }, 'stopped'),
    ).toThrow();
    registry.reconcile('codex_1', binding, 'stopped');
    expect(registry.status('codex_1')).toBe('idle');
    expect(() => registry.begin('codex_1', binding)).toThrow('STALE_EVIDENCE');
    registry.begin('codex_1', { ...binding, generation: 2 });
  });
  it('rejects wrong identity and stale generations without freeing reservations', () => {
    const registry = new ProviderRegistry();
    registry.register(worker());
    registry.begin('codex_1', binding);
    for (const patch of [
      { workerId: 'other' },
      { taskId: 'other' },
      { attemptId: 'other' },
      { generation: 2 },
      { nativeRunId: 'other' },
      { nativeSessionId: 'other' },
      { runtimeKind: 'claude' },
    ])
      expect(() =>
        registry.receive('codex_1', { ...event(), ...patch }),
      ).toThrow();
    expect(() => registry.begin('codex_1', binding)).toThrow('WORKER_BUSY');
  });
  it('deduplicates identical events and rejects changed duplicates or sequence gaps', () => {
    const registry = new ProviderRegistry();
    registry.register(worker());
    registry.begin('codex_1', binding);
    expect(registry.receive('codex_1', event())).toBe('recorded');
    expect(registry.receive('codex_1', event())).toBe('duplicate');
    expect(() =>
      registry.receive('codex_1', { ...event(), text: 'changed' }),
    ).toThrow('INVALID_EVENT');
    expect(() => registry.receive('codex_1', event(3))).toThrow(
      'INVALID_EVENT',
    );
  });
  it('terminal output never approves work or releases its reservation', () => {
    const registry = new ProviderRegistry();
    registry.register(worker());
    registry.begin('codex_1', binding);
    const done = { ...event(), kind: 'completed' };
    delete (done as { text?: string }).text;
    expect(registry.receive('codex_1', done)).toBe('recorded');
    expect(registry.status('codex_1')).toBe('result_pending');
    expect(registry.receive('codex_1', done)).toBe('duplicate');
    expect(() => registry.receive('codex_1', event(2))).toThrow(
      'INVALID_EVENT',
    );
    expect(() => registry.begin('codex_1', binding)).toThrow('WORKER_BUSY');
    registry.reconcile('codex_1', binding, 'stopped');
  });
  it('rejects worker receipts, oversize output, and malformed envelopes', () => {
    const registry = new ProviderRegistry();
    registry.register(worker());
    registry.begin('codex_1', binding);
    for (const value of [
      { ...event(), receipts: [] },
      { ...event(), text: 'x'.repeat(16385) },
      null,
    ])
      expect(() => registry.receive('codex_1', value)).toThrow();
  });
  it('combines usage by account while retaining unknown and estimated classification', () => {
    expect(
      summarizeUsage([
        { quotaGroupId: 'account', kind: 'measured', tokens: 4 },
        { quotaGroupId: 'account', kind: 'estimated', tokens: 6 },
        { quotaGroupId: 'account', kind: 'unknown' },
      ]),
    ).toEqual([
      {
        quotaGroupId: 'account',
        measuredTokens: 4,
        estimatedTokens: 6,
        unknownSamples: 1,
      },
    ]);
    expect(() =>
      summarizeUsage([{ quotaGroupId: 'account', kind: 'unknown', tokens: 0 }]),
    ).toThrow();
    expect(() =>
      summarizeUsage([
        { quotaGroupId: 'account', kind: 'measured', tokens: -1 },
      ]),
    ).toThrow();
    expect(() =>
      summarizeUsage([
        {
          quotaGroupId: 'account',
          kind: 'measured',
          tokens: Number.MAX_SAFE_INTEGER,
        },
        { quotaGroupId: 'account', kind: 'measured', tokens: 1 },
      ]),
    ).toThrow('LIMIT_EXCEEDED');
  });
});
