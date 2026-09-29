import { afterEach, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  OpenCodeEndpoint,
  createEndpointSecret,
  parseAnnouncement,
  secretDigest,
} from './endpoint.ts';

const secret = createEndpointSecret();
const basic = 'Basic ' + Buffer.from('opencode:' + secret).toString('base64');
let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = undefined;
});
async function serve(
  handler: (path: string, auth: boolean, res: ServerResponse) => void,
): Promise<string> {
  server = createServer((req, res) =>
    handler(req.url ?? '', req.headers.authorization === basic, res),
  );
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  return 'http://127.0.0.1:' + address.port;
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const healthy = (version = '1.18.33') =>
  serve((path, auth, res) =>
    auth ? json(res, 200, { healthy: true, version }) : json(res, 401, {}),
  );

it('accepts only the numeric loopback announcement with a port', () => {
  expect(
    parseAnnouncement('opencode server listening on http://127.0.0.1:4096'),
  ).toBe('http://127.0.0.1:4096');
  for (const line of [
    'opencode server listening on http://0.0.0.0:4096',
    'opencode server listening on http://localhost:4096',
    'opencode server listening on https://127.0.0.1:4096',
    'opencode server listening on http://127.0.0.1',
    'opencode server listening on http://127.0.0.1:0',
    'opencode server listening on http://127.0.0.1:70000',
    'opencode server listening on http://127.0.0.1:4096/path',
    'opencode server listening on http://user@127.0.0.1:4096',
    'something else',
  ])
    expect(() => parseAnnouncement(line)).toThrow('ENDPOINT_REJECTED');
});
it('generates high-entropy secrets and digests without exposing them', () => {
  const other = createEndpointSecret();
  expect(other).not.toBe(secret);
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(secretDigest(secret)).toMatch(/^[a-f0-9]{64}$/);
  expect(() => new OpenCodeEndpoint('http://127.0.0.1:1', 'short')).toThrow(
    'INVALID_INPUT',
  );
  expect(() => new OpenCodeEndpoint('http://10.0.0.1:1', secret)).toThrow(
    'ENDPOINT_REJECTED',
  );
});
it('verifies that auth is enforced and the version is pinned', async () => {
  const origin = await healthy();
  expect(await new OpenCodeEndpoint(origin, secret).verify()).toEqual({
    version: '1.18.33',
  });
  await expect(
    new OpenCodeEndpoint(origin, createEndpointSecret()).verify(),
  ).rejects.toThrow('ENDPOINT_REJECTED');
});
it('refuses a server that answers without authentication', async () => {
  const origin = await serve((path, auth, res) =>
    json(res, 200, { healthy: true, version: '1.18.33' }),
  );
  await expect(new OpenCodeEndpoint(origin, secret).verify()).rejects.toThrow(
    'ENDPOINT_UNAUTHENTICATED',
  );
});
it('refuses an unpinned server version', async () => {
  const origin = await healthy('9.9.9');
  await expect(new OpenCodeEndpoint(origin, secret).verify()).rejects.toThrow(
    'VERSION_UNSUPPORTED',
  );
});
it('bounds responses and refuses redirects and cross-origin paths', async () => {
  const origin = await serve((path, auth, res) => {
    if (path === '/big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('"' + 'x'.repeat(70000) + '"');
    } else if (path === '/redirect') {
      res.writeHead(302, { location: 'http://example.com/' });
      res.end();
    } else if (path === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    } else if (path === '/empty') {
      res.writeHead(204);
      res.end();
    } else json(res, 200, { ok: auth });
  });
  const endpoint = new OpenCodeEndpoint(origin, secret);
  await expect(endpoint.request('GET', '/big')).rejects.toThrow(
    'LIMIT_EXCEEDED',
  );
  await expect(endpoint.request('GET', '/redirect')).rejects.toThrow(
    'ENDPOINT_REJECTED',
  );
  expect(await endpoint.request('GET', '/text')).toEqual({
    status: 200,
    body: undefined,
  });
  expect(await endpoint.request('GET', '/empty')).toEqual({
    status: 204,
    body: undefined,
  });
  expect(await endpoint.request('GET', '/ok')).toEqual({
    status: 200,
    body: { ok: true },
  });
  await expect(endpoint.request('GET', '//evil.example/x')).rejects.toThrow(
    'INVALID_INPUT',
  );
  await expect(endpoint.request('GET', 'relative')).rejects.toThrow(
    'INVALID_INPUT',
  );
  await expect(
    endpoint.request('POST', '/ok', 'x'.repeat(70000)),
  ).rejects.toThrow('LIMIT_EXCEEDED');
});
it('times out a stalled endpoint and reports an unavailable one', async () => {
  const origin = await serve(() => {});
  await expect(
    new OpenCodeEndpoint(origin, secret, 100).request('GET', '/stall'),
  ).rejects.toThrow('ENDPOINT_UNAVAILABLE');
  await expect(
    new OpenCodeEndpoint('http://127.0.0.1:1', secret, 500).request('GET', '/'),
  ).rejects.toThrow('ENDPOINT_UNAVAILABLE');
});
it('streams authenticated events and refuses a non-SSE response', async () => {
  const origin = await serve((path, auth, res) => {
    if (!auth) return json(res, 401, {});
    if (path.startsWith('/event?directory=%2Fwork')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"a":1}\n\n');
      res.end();
    } else json(res, 200, {});
  });
  const endpoint = new OpenCodeEndpoint(origin, secret);
  const chunks: string[] = [];
  const clean = await new Promise<boolean>((resolve) => {
    void endpoint.events(
      '/work',
      (chunk) => chunks.push(chunk.toString()),
      resolve,
    );
  });
  expect(clean).toBe(true);
  expect(chunks.join('')).toBe('data: {"a":1}\n\n');
  await expect(
    endpoint.events(
      '/other',
      () => {},
      () => {},
    ),
  ).rejects.toThrow('ENDPOINT_REJECTED');
  endpoint.close();
});
it('keeps a quiet event stream open past the request timeout', async () => {
  const origin = await serve((path, auth, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    setTimeout(() => res.end('data: {}\n\n'), 300);
  });
  const endpoint = new OpenCodeEndpoint(origin, secret, 100);
  const clean = await new Promise<boolean>((resolve) => {
    void endpoint.events('/work', () => {}, resolve);
  });
  expect(clean).toBe(true);
});
