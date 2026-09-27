import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from './service.ts';
import Database from 'better-sqlite3';
import { Store } from '../../../packages/storage/src/store.ts';
let service: Awaited<ReturnType<typeof startService>> | undefined;
let root: string | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
it('creates, queues, executes and accepts through authenticated HTTP', async () => {
  root = mkdtempSync(join(tmpdir(), 'xvant-service-'));
  service = await startService(root, {
    test: {
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
    },
  });
  const { origin, bootstrapToken } = service;
  const login = await fetch(origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: origin, Authorization: 'Bearer ' + bootstrapToken },
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const headers = {
    Origin: origin,
    Cookie: cookie,
    'X-CSRF-Token': csrfToken,
    'Content-Type': 'application/json',
  };
  const send = async (path: string, key: string, body: unknown) => {
    const res = await fetch(origin + '/api/v1/' + path, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBe(202);
    return (await res.json()) as { state: string; rowVersion: number };
  };
  const task = await send('tasks', 'create', {
    id: 'task',
    projectId: 'project',
    objective: 'Fixture',
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Pass'],
  });
  const queued = await send('tasks/task/queue', 'queue', {
    expectedVersion: task.rowVersion,
  });
  const result = await send('tasks/task/dispatch', 'dispatch', {
    workerId: 'worker',
    attemptId: 'attempt',
    workspaceId: 'workspace',
    sessionId: 'session',
    scenario: 'success',
    expectedVersion: queued.rowVersion,
  });
  expect(result.state).toBe('ready_for_acceptance');
  expect(
    (
      await send('tasks/task/accept', 'accept', {
        expectedVersion: result.rowVersion,
      })
    ).state,
  ).toBe('accepted');
  const events = await fetch(origin + '/api/v1/events?after=0', {
    headers: { Cookie: cookie },
  });
  expect(events.status).toBe(200);
  expect(JSON.stringify(await events.json())).not.toContain('token');
}, 15000);

it('releases ownership when controller construction rejects uncloneable checks', async () => {
  root = mkdtempSync(join(tmpdir(), 'xvant-service-startup-'));
  const checks = {
    test: {
      executable: process.execPath,
      args: [],
      cwd: process.cwd(),
      hook: () => undefined,
    },
  };
  await expect(startService(root, checks)).rejects.toThrow();
  const next = new Store(join(root, 'state.sqlite'), { owner: 'next' });
  next.close();
});

it('releases ownership when corrupted pending state prevents recovery', async () => {
  root = mkdtempSync(join(tmpdir(), 'xvant-service-recovery-'));
  const path = join(root, 'state.sqlite');
  const previous = new Store(path, { owner: 'previous' });
  previous.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Recovery fixture',
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Pass'],
  });
  previous.queue('queue', 'task', 0);
  const op = previous.dispatch('dispatch', {
    taskId: 'task',
    workerId: 'worker',
    attemptId: 'attempt',
    workspaceId: 'workspace',
    sessionId: 'session',
    scenario: 'success',
    expectedVersion: 1,
  });
  previous.markSending(op.attemptId, op.token);
  previous.close();
  const database = new Database(path);
  try {
    const row = database
      .prepare('SELECT body FROM tasks WHERE id=?')
      .get('task') as { body: string };
    const task = JSON.parse(row.body) as Record<string, unknown>;
    database
      .prepare('UPDATE tasks SET body=? WHERE id=?')
      .run(JSON.stringify({ ...task, state: 'accepted' }), 'task');
  } finally {
    database.close();
  }
  await expect(startService(root, {})).rejects.toThrow();
  const next = new Store(path, { owner: 'next' });
  next.close();
});
