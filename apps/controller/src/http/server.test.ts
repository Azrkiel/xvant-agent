import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { DomainError } from '../../../../packages/contracts/src/index.ts';
import { StorageError } from '../../../../packages/storage/src/store.ts';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startLoopbackApi } from './server.ts';
import type { ApiCommand } from './server.ts';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function setup(maxBodyBytes = 1024) {
  const commands: ApiCommand[] = [];
  const api = await startLoopbackApi({
    maxBodyBytes,
    command: async (command) => {
      commands.push(command);
      if (command.input.failure === 'domain')
        throw new DomainError('NOT_FOUND', 'secret path');
      if (command.input.failure === 'storage')
        throw new StorageError('CONFLICT');
      if (command.input.failure === 'unknownStorage')
        throw new StorageError('secret path');
      if (command.input.failure === 'validation')
        z.string().parse({ secret: 'password' });
      if (command.kind === 'dispatch' && command.taskId === 'fail')
        throw new Error('secret password internal-path');
      return { accepted: true };
    },
    events: async (after) => [{ sequence: after + 1, kind: 'created' }],
  });
  cleanup.push(api.close);
  const send = (
    path: string,
    method = 'GET',
    headers: Record<string, string> = {},
    body = '',
  ) =>
    new Promise<{
      status: number;
      body: string;
      headers: import('node:http').IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = request(api.origin + path, { method, headers }, (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: text,
            headers: res.headers,
          }),
        );
      });
      req.on('error', reject);
      req.end(body);
    });
  const login = await send('/api/v1/session', 'POST', {
    origin: api.origin,
    authorization: `Bearer ${api.bootstrapToken}`,
  });
  const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
  const csrf = (JSON.parse(login.body) as { csrfToken: string }).csrfToken;
  const headers = {
    cookie,
    origin: api.origin,
    'x-csrf-token': csrf,
    'content-type': 'application/json',
    'idempotency-key': 'command_1',
  };
  return { api, send, commands, login, headers };
}
describe('authenticated loopback API', () => {
  it('exchanges a single-use capability for an HttpOnly strict cookie', async () => {
    const { api, send, login } = await setup();
    expect(api.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie']![0]).toContain('HttpOnly');
    expect(login.headers['set-cookie']![0]).toContain('SameSite=Strict');
    expect(login.body).not.toContain(api.bootstrapToken);
    expect(
      (
        await send('/api/v1/session', 'POST', {
          origin: api.origin,
          authorization: `Bearer ${api.bootstrapToken}`,
        })
      ).status,
    ).toBe(401);
  });
  it('passes authenticated commands and event cursors to the controller', async () => {
    const { send, headers, commands } = await setup();
    expect(
      (await send('/api/v1/tasks', 'POST', headers, '{"id":"task_1"}')).status,
    ).toBe(202);
    expect(
      (await send('/api/v1/tasks/task_1/dispatch', 'POST', headers, '{}'))
        .status,
    ).toBe(202);
    expect(commands).toEqual([
      { kind: 'create', commandId: 'command_1', input: { id: 'task_1' } },
      { kind: 'dispatch', commandId: 'command_1', taskId: 'task_1', input: {} },
    ]);
    expect(
      JSON.parse((await send('/api/v1/events?after=2', 'GET', headers)).body),
    ).toEqual([{ sequence: 3, kind: 'created' }]);
  });
  it('rejects unauthenticated streams and mutation CSRF, host, and origin attacks', async () => {
    const { send, headers } = await setup();
    expect((await send('/api/v1/events')).status).toBe(401);
    for (const overrides of [
      { cookie: '' },
      { origin: 'https://evil.example' },
      { origin: '' },
      { host: 'evil.example' },
      { 'x-csrf-token': '' },
    ]) {
      expect(
        (
          await send(
            '/api/v1/tasks',
            'POST',
            { ...headers, ...overrides },
            '{}',
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(
      (await send('/api/v1/events', 'GET', { ...headers, origin: 'null' }))
        .status,
    ).toBe(403);
  });
  it('bounds bodies, validates routing, JSON, cursors and command identity', async () => {
    const { send, headers, commands } = await setup(64);
    expect(
      (await send('/api/v1/tasks', 'POST', headers, 'x'.repeat(65))).status,
    ).toBe(413);
    expect((await send('/api/v1/tasks', 'POST', headers, '{')).status).toBe(
      400,
    );
    expect((await send('/api/v1/tasks', 'POST', headers, '[]')).status).toBe(
      400,
    );
    expect(
      (
        await send(
          '/api/v1/tasks',
          'POST',
          { ...headers, 'idempotency-key': '' },
          '{}',
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          '/api/v1/tasks',
          'POST',
          { ...headers, 'content-type': 'text/plain' },
          '{}',
        )
      ).status,
    ).toBe(415);
    expect((await send('/api/v1/events?after=-1', 'GET', headers)).status).toBe(
      400,
    );
    expect(
      (await send('/api/v1/tasks/%2e%2e/dispatch', 'POST', headers, '{}'))
        .status,
    ).toBe(404);
    expect(
      (await send('/api/v1/files?path=C:/secret', 'GET', headers)).status,
    ).toBe(404);
    expect(commands).toEqual([]);
  });
  it('redacts internal exceptions and disables caching and CORS', async () => {
    const { send, headers } = await setup();
    const response = await send(
      '/api/v1/tasks/fail/dispatch',
      'POST',
      headers,
      '{}',
    );
    expect(response.status).toBe(500);
    expect(response.body).toBe('{"error":"INTERNAL_ERROR"}');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

it('loads in the pinned Node strip-only runtime', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(new URL('./server.ts', import.meta.url).href)})`,
    ],
    { encoding: 'utf8' },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
it('routes queue and accept through the authenticated command boundary', async () => {
  const { send, headers, commands } = await setup();
  for (const kind of ['queue', 'accept'])
    expect(
      (
        await send(
          `/api/v1/tasks/task_1/${kind}`,
          'POST',
          headers,
          '{"expectedVersion":1}',
        )
      ).status,
    ).toBe(202);
  expect(commands.map((command) => command.kind)).toEqual(['queue', 'accept']);
});
it.each([
  ['domain', 404, 'NOT_FOUND'],
  ['storage', 409, 'CONFLICT'],
  ['validation', 400, 'INVALID_INPUT'],
  ['unknownStorage', 500, 'INTERNAL_ERROR'],
])(
  'maps %s failures without exposing messages',
  async (failure, status, error) => {
    const { send, headers } = await setup();
    const response = await send(
      '/api/v1/tasks',
      'POST',
      headers,
      JSON.stringify({ failure }),
    );
    expect(response.status).toBe(status);
    expect(JSON.parse(response.body)).toEqual({ error });
  },
);
