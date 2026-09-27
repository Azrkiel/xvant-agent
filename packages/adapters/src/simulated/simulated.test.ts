import { describe, it, expect } from 'vitest';
import { SimulatedAdapter } from './index.ts';
import { eventSchema } from '../../../contracts/src/index.ts';
import type { RunRequest } from '../../../contracts/src/index.ts';
const request: RunRequest = {
  taskId: 'task_a',
  attemptId: 'attempt_a',
  workerId: 'worker_a',
  scenario: 'success',
};
async function collect(
  adapter = new SimulatedAdapter(),
  req = request,
  signal?: AbortSignal,
) {
  const events = [];
  for await (const event of adapter.run(req, signal)) events.push(event);
  return events;
}
describe('simulated adapter', () => {
  it('emits deterministic validated events explicitly marked simulated', async () => {
    const events = await collect();
    expect(events).toEqual(await collect());
    expect(events.map((e) => eventSchema.parse(e).kind)).toEqual([
      'started',
      'output',
      'completed',
    ]);
    for (const event of events)
      expect(event).toMatchObject({
        runtimeKind: 'simulated',
        simulated: true,
        schemaVersion: 1,
      });
  });
  it.each(['failure', 'quota', 'unknown'] as const)(
    'emits scenario %s',
    async (scenario) => {
      const events = await collect(new SimulatedAdapter(), {
        ...request,
        scenario,
      });
      expect(events.at(-1)).toMatchObject({
        kind: scenario === 'failure' ? 'failed' : scenario,
      });
    },
  );
  it('emits intentionally malformed fixture data', async () => {
    const events = await collect(new SimulatedAdapter(), {
      ...request,
      scenario: 'malformed',
    });
    expect(eventSchema.safeParse(events.at(-1)).success).toBe(false);
  });
  it('waits on injected delay before producing completed output', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new SimulatedAdapter(() => pending);
    const iterator = adapter
      .run({ ...request, scenario: 'delayed' })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: 'started' });
    let settled = false;
    const next = iterator.next().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect((await next).value).toMatchObject({ kind: 'output' });
    expect((await iterator.next()).value).toMatchObject({ kind: 'completed' });
  });
  it('supports default delayed execution', async () =>
    expect(
      (
        await collect(new SimulatedAdapter(), {
          ...request,
          scenario: 'delayed',
        })
      ).at(-1),
    ).toMatchObject({ kind: 'completed' }));
  it('handles cancellation before execution', async () => {
    const abort = new AbortController();
    abort.abort();
    expect(
      await collect(new SimulatedAdapter(), request, abort.signal),
    ).toMatchObject([{ kind: 'cancelled' }]);
  });
  it('handles cancellation during delay', async () => {
    const abort = new AbortController();
    const iterator = new SimulatedAdapter()
      .run({ ...request, scenario: 'delayed' }, abort.signal)
      [Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();
    abort.abort();
    expect((await next).value).toMatchObject({ kind: 'cancelled' });
  });
  it('validates incoming requests', async () =>
    await expect(
      collect(new SimulatedAdapter(), { ...request, taskId: '../bad' }),
    ).rejects.toThrow(/INVALID_INPUT/));
});
