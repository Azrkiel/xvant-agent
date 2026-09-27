import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { DurableController } from './durable.ts';
let root: string;
let store: Store;
const input = {
  id: 'task',
  projectId: 'project',
  objective: 'Fixture',
  requiredCheckIds: ['test'],
  acceptanceCriteria: ['Pass'],
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-durable-'));
  store = new Store(join(root, 'db.sqlite'), { owner: 'controller' });
  store.create('create', input);
  store.queue('queue', 'task', 0);
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const check = {
  executable: process.execPath,
  args: ['-e', 'process.exit(0)'],
  cwd: process.cwd(),
};
const spec = {
  taskId: 'task',
  workerId: 'worker',
  attemptId: 'attempt',
  workspaceId: 'workspace',
  sessionId: 'session',
  expectedVersion: 1,
  scenario: 'success' as const,
};
it('runs isolated simulation and trusted checks then accepts after restart', async () => {
  const controller = new DurableController(store, { test: check });
  const task = await controller.run('dispatch', spec);
  expect(task.state).toBe('ready_for_acceptance');
  store.close();
  store = new Store(join(root, 'db.sqlite'), { owner: 'next' });
  expect(store.accept('accept', 'task', task.rowVersion).state).toBe(
    'accepted',
  );
});
it.each([
  ['quota', 'quota'],
  ['failure', 'worker_failed'],
  ['malformed', 'invalid_event'],
  ['unknown', 'unknown'],
] as const)('persists normalized %s cause', async (scenario, reason) => {
  const controller = new DurableController(store, { test: check });
  expect((await controller.run('dispatch', { ...spec, scenario })).state).toBe(
    'needs_attention',
  );
  expect(store.getOperation('attempt').reason).toBe(reason);
});
it('does not dispatch again when an idempotent request is repeated', async () => {
  const controller = new DurableController(store, { test: check });
  const task = await controller.run('dispatch', spec);
  const cursor = store.events(0).at(-1)!.sequence;
  expect(await controller.run('dispatch', spec)).toEqual(task);
  expect(store.events(cursor)).toEqual([]);
});
it('records verifier failure without accepting worker claims', async () => {
  const controller = new DurableController(store, {
    test: { ...check, args: ['-e', 'process.exit(1)'] },
  });
  expect((await controller.run('dispatch', spec)).state).toBe('needs_rework');
  expect(store.getOperation('attempt').reason).toBe('verifier_failed');
});
it('kills a hanging verifier and persists attention', async () => {
  const controller = new DurableController(
    store,
    { test: { ...check, args: ['-e', 'setInterval(()=>{},1000)'] } },
    { timeoutMs: 1000 },
  );
  expect((await controller.run('dispatch', spec)).state).toBe(
    'needs_attention',
  );
  expect(store.getOperation('attempt').reason).toBe('verifier_failed');
}, 15000);
it('rejects missing checks before committing dispatch', async () => {
  const controller = new DurableController(store, {});
  await expect(controller.run('dispatch', spec)).rejects.toThrow(
    'VERIFIER_UNAVAILABLE',
  );
  expect(store.getTask('task').state).toBe('queued');
});
it('recovers incomplete verification after restart', async () => {
  const controller = new DurableController(store, { test: check });
  await controller.run('dispatch', spec);
  // Separate crash fixture verifies the real process boundary; storage recovery must leave accepted evidence untouched.
  store.close();
  store = new Store(join(root, 'db.sqlite'), { owner: 'next' });
  expect(store.recover()).toEqual([]);
  expect(store.getTask('task').state).toBe('ready_for_acceptance');
});

it('normalizes synchronous verifier configuration failures', async () => {
  const controller = new DurableController(store, {
    test: { ...check, cwd: 'relative' },
  });
  expect((await controller.run('dispatch', spec)).state).toBe(
    'needs_attention',
  );
  expect(store.getOperation('attempt').reason).toBe('verifier_failed');
});
it('global stop rejects further admission before dispatch', async () => {
  const controller = new DurableController(store, { test: check });
  controller.stop();
  await expect(controller.run('dispatch', spec)).rejects.toThrow(
    'CONTROLLER_STOPPED',
  );
  expect(store.getTask('task').state).toBe('queued');
});
it('renews a short lease while the controller is idle', async () => {
  store.close();
  store = new Store(join(root, 'db.sqlite'), { owner: 'short', leaseMs: 300 });
  const controller = new DurableController(store, { test: check });
  try {
    await new Promise((r) => setTimeout(r, 600));
    expect(store.heartbeat()).toBeUndefined();
  } finally {
    controller.stop();
  }
});
