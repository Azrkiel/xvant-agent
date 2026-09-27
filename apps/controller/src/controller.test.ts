import { describe, it, expect } from 'vitest';
import { Controller } from './controller.ts';
import { SimulatedAdapter } from '../../../packages/adapters/src/simulated/index.ts';
import type {
  RuntimeAdapter,
  RunRequest,
  Task,
  Worker,
} from '../../../packages/contracts/src/index.ts';
const input = {
  id: 'task_a',
  projectId: 'project_a',
  objective: 'Implement routing',
  requiredCheckIds: ['unit'],
  acceptanceCriteria: ['Tests pass'],
};
const worker: Worker = {
  id: 'worker_a',
  alias: 'coder_a',
  hostId: 'local',
  runtimeKind: 'simulated',
  nativeSessionId: 'session_a',
};
function setup(
  adapter: RuntimeAdapter = new SimulatedAdapter(),
  check: (task: Readonly<Task>) => Promise<boolean> = async () => true,
) {
  const c = new Controller(adapter, { unit: check });
  c.registerWorker(worker);
  c.create(input);
  c.queue('task_a');
  return c;
}
function custom(events: (r: RunRequest) => unknown[]): RuntimeAdapter {
  return {
    runtimeKind: 'simulated',
    async *run(r) {
      for (const e of events(r)) yield e;
    },
  };
}
function started(r: RunRequest) {
  return {
    taskId: r.taskId,
    attemptId: r.attemptId,
    workerId: r.workerId,
    schemaVersion: 1,
    sequence: 1,
    runtimeKind: 'simulated',
    simulated: true,
    kind: 'started',
  };
}
describe('in-memory controller', () => {
  it('runs through trusted verification and requires explicit acceptance', async () => {
    const c = setup();
    expect(
      (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
    ).toBe('ready_for_acceptance');
    expect(c.getAttempt('attempt_a').state).toBe('succeeded');
    expect(c.accept('task_a').state).toBe('accepted');
  });
  it('refuses acceptance without verification', () => {
    const c = setup();
    expect(() => c.accept('task_a')).toThrow(/ILLEGAL_TRANSITION/);
  });
  it('rejects duplicate tasks and worker identities/aliases/sessions', () => {
    const c = setup();
    expect(() => c.create(input)).toThrow(/DUPLICATE_IDENTITY/);
    for (const change of [
      {},
      { id: 'worker_b' },
      { id: 'worker_b', alias: 'coder_b' },
      { id: 'worker_b', nativeSessionId: 'session_b' },
    ])
      expect(() => c.registerWorker({ ...worker, ...change })).toThrow(
        /DUPLICATE_IDENTITY/,
      );
  });
  it('permits the same native session id on a different host', () => {
    const c = setup();
    expect(() =>
      c.registerWorker({
        ...worker,
        id: 'worker_b',
        alias: 'coder_b',
        hostId: 'remote',
      }),
    ).not.toThrow();
  });
  it('rejects unavailable verifier checks before creating work', () => {
    const c = setup();
    expect(() =>
      c.create({ ...input, id: 'task_b', requiredCheckIds: ['missing'] }),
    ).toThrow(/INVALID_INPUT/);
  });
  it.each(['failure', 'quota', 'unknown', 'malformed'] as const)(
    'handles %s without accepting or retrying',
    async (scenario) => {
      const c = setup();
      expect(
        (await c.run('task_a', 'worker_a', 'attempt_a', scenario)).state,
      ).toBe('needs_attention');
      expect(c.getAttempt('attempt_a').state).toBe(
        scenario === 'failure' || scenario === 'quota' ? 'failed' : 'unknown',
      );
      expect(() => c.accept('task_a')).toThrow();
    },
  );
  it('failed trusted check routes work to needs_rework', async () => {
    const c = setup(new SimulatedAdapter(), async () => false);
    expect(
      (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
    ).toBe('needs_rework');
    expect(() => c.accept('task_a')).toThrow();
  });
  it('a verifier exception becomes needs_attention without leaking its message', async () => {
    const c = setup(new SimulatedAdapter(), async () => {
      throw new Error('secret');
    });
    expect(
      (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
    ).toBe('needs_attention');
    expect(JSON.stringify(c.getTask('task_a'))).not.toContain('secret');
  });
  it('unknown outcome does not automatically redispatch', async () => {
    let runs = 0;
    const c = setup({
      runtimeKind: 'simulated',
      async *run() {
        runs++;
        yield {};
      },
    });
    await c.run('task_a', 'worker_a', 'attempt_a', 'success');
    expect(runs).toBe(1);
    expect(c.getTask('task_a').state).toBe('needs_attention');
  });
  it('rejects malformed, mismatched and out-of-order events', async () => {
    for (const events of [
      (r: RunRequest) => [{ ...started(r), taskId: 'other' }],
      (r: RunRequest) => [{ ...started(r), sequence: 2 }],
      (r: RunRequest) => [started(r), started(r)],
      (r: RunRequest) => [{ ...started(r), kind: 'output', text: 'bad' }],
      () => [{ untrusted: 'secret' }],
    ]) {
      const c = setup(custom(events));
      expect(
        (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
      ).toBe('needs_attention');
    }
  });
  it('rejects empty and unterminated streams', async () => {
    for (const events of [() => [], (r: RunRequest) => [started(r)]]) {
      const c = setup(custom(events));
      expect(
        (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
      ).toBe('needs_attention');
    }
  });
  it('rejects trailing output after a terminal event', async () => {
    const source = new SimulatedAdapter();
    const c = setup({
      runtimeKind: 'simulated',
      async *run(r) {
        yield* source.run(r);
        yield started(r);
      },
    });
    expect(
      (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
    ).toBe('needs_attention');
  });
  it('turns adapter exceptions into unknown outcomes', async () => {
    const c = setup({
      runtimeKind: 'simulated',
      async *run(r) {
        yield started(r);
        throw new Error('secret');
      },
    });
    expect(
      (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
    ).toBe('needs_attention');
  });
  it('limits event floods', async () => {
    const c = setup({
      runtimeKind: 'simulated',
      async *run(r) {
        yield started(r);
        for (let sequence = 2; sequence < 300; sequence++)
          yield { ...started(r), kind: 'output', sequence, text: 'x' };
      },
    });
    expect(
      (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
    ).toBe('needs_attention');
  });
  it('locks a worker during an active turn and supports other workers', async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const c = setup(new SimulatedAdapter(() => pending));
    c.create({ ...input, id: 'task_b' });
    c.queue('task_b');
    c.registerWorker({
      ...worker,
      id: 'worker_b',
      alias: 'coder_b',
      nativeSessionId: 'session_b',
    });
    const run = c.run('task_a', 'worker_a', 'attempt_a', 'delayed');
    await expect(
      c.run('task_b', 'worker_a', 'attempt_b', 'success'),
    ).rejects.toThrow(/WORKER_BUSY/);
    expect(
      (await c.run('task_b', 'worker_b', 'attempt_b', 'success')).state,
    ).toBe('ready_for_acceptance');
    release();
    await run;
  });
  it('rejects duplicate attempts and invalid dispatches', async () => {
    const c = setup();
    await c.run('task_a', 'worker_a', 'attempt_a', 'success');
    await expect(
      c.run('task_a', 'worker_a', 'attempt_b', 'success'),
    ).rejects.toThrow(/ILLEGAL_TRANSITION/);
    c.create({ ...input, id: 'task_b' });
    c.queue('task_b');
    await expect(
      c.run('task_b', 'worker_a', 'attempt_a', 'success'),
    ).rejects.toThrow(/DUPLICATE_IDENTITY/);
  });
  it('rejects missing objects without changing state', async () => {
    const c = setup();
    expect(() => c.getTask('missing')).toThrow(/NOT_FOUND/);
    expect(() => c.getAttempt('missing')).toThrow(/NOT_FOUND/);
    await expect(
      c.run('task_a', 'missing', 'attempt_a', 'success'),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(c.getTask('task_a').state).toBe('queued');
  });
  it('returns defensive snapshots and isolates verifier mutation', async () => {
    const c = setup(new SimulatedAdapter(), async (task) => {
      (task.requiredCheckIds as string[]).push('untrusted');
      return true;
    });
    const view = c.getTask('task_a');
    view.requiredCheckIds.push('external');
    expect(
      (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
    ).toBe('ready_for_acceptance');
    const attempt = c.getAttempt('attempt_a');
    attempt.state = 'failed';
    expect(c.getAttempt('attempt_a').state).toBe('succeeded');
  });
  it('invalidates stored receipts when work is edited', async () => {
    const c = setup();
    await c.run('task_a', 'worker_a', 'attempt_a', 'success');
    c.revise('task_a', {
      objective: 'New',
      requiredCheckIds: ['unit'],
      acceptanceCriteria: ['New'],
    });
    expect(() => c.accept('task_a')).toThrow();
    expect(c.getTask('task_a').workRevision).toBe(1);
  });
  it('cancels a simulated attempt before or during execution', async () => {
    const c = setup();
    const a = new AbortController();
    a.abort();
    expect(
      (await c.run('task_a', 'worker_a', 'attempt_a', 'success', a.signal))
        .state,
    ).toBe('cancelled');
    expect(c.getAttempt('attempt_a').state).toBe('cancelled');
  });
});

describe('adapter input isolation', () => {
  it('rejects an adapter that mutates its request to impersonate another task', async () => {
    const source = new SimulatedAdapter();
    const c = setup({
      runtimeKind: 'simulated',
      async *run(request) {
        request.taskId = 'other_task';
        yield* source.run(request);
      },
    });
    expect(
      (await c.run('task_a', 'worker_a', 'attempt_a', 'success')).state,
    ).toBe('needs_attention');
  });
});
