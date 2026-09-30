import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_ROUTES } from '../../../packages/contracts/src/live.ts';
import type { ProviderKind } from '../../../packages/contracts/src/providers.ts';
import { startApp } from './app.ts';

vi.setConfig({ testTimeout: 120000 });
const fixture = (name: string) =>
  fileURLToPath(new URL('../../../tests/fixtures/' + name, import.meta.url));
const FAKES: Record<ProviderKind, string[]> = {
  codex: [fixture('codex-live-peer.mjs'), 'write'],
  claude: [fixture('claude-live-peer.mjs'), 'write'],
  opencode: [fixture('opencode-cli.mjs'), 'tools'],
};
let root: string, repo: string, app: Awaited<ReturnType<typeof startApp>>;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-app-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      {
        cwd: repo,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  app = await startApp({
    home: join(root, 'home'),
    discover: (kind) => ({
      runtimeKind: kind,
      status: 'qualified',
      executable: process.execPath,
      version: LIVE_ROUTES[kind].runtimeVersion,
      expectedVersion: LIVE_ROUTES[kind].runtimeVersion,
      candidates: 1,
      prefixArgs: FAKES[kind],
    }),
  });
});
afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
type Reply = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};
function send(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(app.origin + path, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode!, headers: res.headers, body: text }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}
async function login() {
  const reply = await send('/api/v1/session', 'POST', {
    authorization: 'Bearer ' + app.bootstrapToken,
    origin: app.origin,
  });
  const cookie = String(reply.headers['set-cookie']).split(';')[0]!;
  const { csrfToken } = JSON.parse(reply.body) as { csrfToken: string };
  const get = (path: string) => send(path, 'GET', { cookie });
  const post = (path: string, body: unknown) =>
    send(
      path,
      'POST',
      {
        cookie,
        origin: app.origin,
        'x-csrf-token': csrfToken,
        'content-type': 'application/json',
      },
      body,
    );
  return { cookie, csrfToken, get, post };
}
const objective =
  'Create a file named app.txt in the current directory whose entire content is the single line: hello app. Do not change anything else.';
const check = `"${process.execPath}" -e "if(require('fs').readFileSync('app.txt','utf8').trim()!=='hello app')process.exit(1)"`;
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

it('serves the page publicly with a strict policy and guards every API call', async () => {
  const page = await send('/');
  expect(page.status).toBe(200);
  expect(page.headers['content-security-policy']).toContain(
    "script-src 'self'",
  );
  expect(page.body).toContain('<main id="main"');
  expect((await send('/api/v1/overview')).status).toBe(401);
  expect(
    (await send('/api/v1/overview', 'GET', { host: 'evil.example' })).status,
  ).toBe(403);
  const session = await login();
  // The bootstrap capability is single use.
  expect(
    (
      await send('/api/v1/session', 'POST', {
        authorization: 'Bearer ' + app.bootstrapToken,
        origin: app.origin,
      })
    ).status,
  ).toBe(401);
  expect((await session.get('/api/v1/overview')).status).toBe(200);
  expect(JSON.parse((await session.get('/api/v1/csrf')).body).csrfToken).toBe(
    session.csrfToken,
  );
  const noCsrf = await send(
    '/api/v1/stop',
    'POST',
    {
      cookie: session.cookie,
      origin: app.origin,
      'content-type': 'application/json',
    },
    {},
  );
  expect(noCsrf.status).toBe(403);
  const foreign = await send(
    '/api/v1/stop',
    'POST',
    {
      cookie: session.cookie,
      origin: 'https://evil.example',
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    },
    {},
  );
  expect(foreign.status).toBe(403);
});

it('runs a task end to end, once per submission, and accepts only what was reviewed', async () => {
  const s = await login();
  const body = {
    commandId: 'ui-1',
    repository: repo,
    objective,
    checks: [check],
  };
  const first = JSON.parse((await s.post('/api/v1/roots', body)).body);
  const again = JSON.parse((await s.post('/api/v1/roots', body)).body);
  expect(again).toEqual({ id: first.id, created: false });
  const root = await until(
    async () => JSON.parse((await s.get('/api/v1/roots/' + first.id)).body),
    (r) => ['ready', 'failed', 'needs_attention'].includes(r.state.phase),
  );
  expect(root.state.reason).toBeUndefined();
  expect(root.state.phase).toBe('ready');
  expect(root.state.checks).toEqual([
    expect.objectContaining({ id: 'check1', status: 'passed' }),
  ]);
  expect(root.state.review).toMatchObject({ approve: true, independent: true });
  expect(root.repository).toBe(repo);
  const overview = JSON.parse((await s.get('/api/v1/overview')).body);
  expect(overview.roots.map((r: { id: string }) => r.id)).toEqual([first.id]);
  expect(overview.workers).toHaveLength(10);
  const diff = JSON.parse(
    (await s.get('/api/v1/roots/' + first.id + '/diff')).body,
  );
  expect(diff.diff).toContain('+hello app');
  // A stale version or head is refused; the reviewed pair is accepted.
  expect(
    (
      await s.post('/api/v1/roots/' + first.id + '/accept', {
        expectedVersion: root.rowVersion - 1,
        head: root.state.integration.head,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await s.post('/api/v1/roots/' + first.id + '/accept', {
        expectedVersion: root.rowVersion,
        head: '0'.repeat(40),
      })
    ).status,
  ).toBe(409);
  const accepted = await s.post('/api/v1/roots/' + first.id + '/accept', {
    expectedVersion: root.rowVersion,
    head: root.state.integration.head,
  });
  expect(accepted.status).toBe(202);
  expect(
    JSON.parse((await s.get('/api/v1/roots/' + first.id)).body).state.phase,
  ).toBe('accepted');
  // The user's checkout is untouched.
  expect(
    execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
    }),
  ).toBe('');
});

it('streams run events and resumes from the last event ID', async () => {
  const s = await login();
  const { id } = JSON.parse(
    (
      await s.post('/api/v1/roots', {
        commandId: 'ui-2',
        repository: repo,
        objective,
      })
    ).body,
  );
  await until(
    async () => JSON.parse((await s.get('/api/v1/roots/' + id)).body),
    (r) => r.state.phase === 'ready',
  );
  const read = (headers: Record<string, string>) =>
    new Promise<string>((resolve, reject) => {
      const req = request(
        app.origin + '/api/v1/stream',
        { headers: { cookie: s.cookie, ...headers } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
            if (text.includes('graph.ready')) {
              req.destroy();
              resolve(text);
            }
          });
        },
      );
      req.on('error', (error) =>
        error.message.includes('socket hang up') ? undefined : reject(error),
      );
      setTimeout(() => {
        req.destroy();
        resolve('');
      }, 5000);
      req.end();
    });
  const all = await read({});
  expect(all).toContain('"kind":"graph.created"');
  const ids = [...all.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  const resumed = await read({ 'last-event-id': String(ids.at(-2)) });
  expect(resumed).not.toContain('"kind":"graph.created"');
  expect(resumed).toContain('graph.ready');
});

it('rejects a folder that is not a Git repository and stops running work', async () => {
  const s = await login();
  const bad = await s.post('/api/v1/roots', {
    commandId: 'ui-3',
    repository: root,
    objective,
  });
  expect(bad.status).toBe(400);
  expect(JSON.parse(bad.body).error).toBe('INVALID_REPOSITORY');
  const { id } = JSON.parse(
    (
      await s.post('/api/v1/roots', {
        commandId: 'ui-4',
        repository: repo,
        objective:
          'Create 40 files named step_01.txt through step_40.txt one at a time.',
      })
    ).body,
  );
  await until(
    async () => JSON.parse((await s.get('/api/v1/overview')).body),
    (o) => o.workers.some((w: { state: string }) => w.state === 'running'),
  );
  expect((await s.post('/api/v1/stop', {})).status).toBe(202);
  const stopped = await until(
    async () => JSON.parse((await s.get('/api/v1/roots/' + id)).body),
    (r) => ['cancelled', 'needs_attention', 'failed'].includes(r.state.phase),
  );
  expect(stopped.state.phase).toBe('cancelled');
});
