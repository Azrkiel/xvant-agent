// Fixed offline OpenCode-shaped HTTP server. Never runs a model or a tool.
// Mirrors `opencode serve`: loopback listener, startup announcement and HTTP
// basic auth from OPENCODE_SERVER_PASSWORD (username `opencode`).
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

const [command, hostnameArg, portArg, scenario = 'success'] =
  process.argv.slice(2);
if (
  command !== 'serve' ||
  hostnameArg !== '--hostname=127.0.0.1' ||
  portArg !== '--port=0'
)
  process.exit(40);
const secret = process.env.OPENCODE_SERVER_PASSWORD ?? '';
const expected =
  'Basic ' + Buffer.from('opencode:' + secret).toString('base64');
let session;
let counter = 0;
const streams = new Set();
const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};
const emit = (type, properties) => {
  for (const res of streams)
    res.write(
      'data: ' +
        JSON.stringify({ id: 'event-' + ++counter, type, properties }) +
        '\n\n',
    );
};
const sessionBody = (id, directory, created) => ({
  id,
  slug: 'fixture',
  projectID: 'project',
  directory,
  title: 'fixture',
  version: 'fixture',
  ...(created
    ? {
        permission: [
          {
            permission: '*',
            pattern: '*',
            action: scenario === 'create-permission' ? 'allow' : 'deny',
          },
        ],
      }
    : {}),
  time: { created: 1, updated: 1 },
});
let parent;
const complete = (error) =>
  emit('message.updated', {
    sessionID: session,
    info: {
      id: 'assistant-1',
      sessionID: session,
      parentID: parent,
      role: 'assistant',
      time: { created: 1, completed: 2 },
      modelID: 'fixture',
      providerID: 'fixture',
      mode: 'fixture',
      agent: 'fixture',
      path: { cwd: '/fixture', root: '/fixture' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: 'stop',
      ...(error ? { error } : {}),
    },
  });
const read = (req) =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => resolve(text ? JSON.parse(text) : undefined));
  });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (scenario !== 'no-auth' && req.headers.authorization !== expected)
    return json(res, 401, { name: 'Unauthorized' });
  const route = req.method + ' ' + url.pathname;
  const directory = url.searchParams.get('directory');
  if (route === 'GET /global/health')
    return json(res, 200, {
      healthy: true,
      version: scenario === 'wrong-version' ? '0.0.1' : '1.18.33',
    });
  if (route === 'GET /event') {
    if (directory !== process.cwd()) return json(res, 400, {});
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    res.flushHeaders();
    streams.add(res);
    return;
  }
  if (route === 'POST /session') {
    await read(req);
    if (directory !== process.cwd()) return json(res, 400, {});
    session = 'created-1';
    return json(res, 200, sessionBody(session, directory, true));
  }
  const match = /^\/session\/([^/]+)(\/abort|\/prompt_async)?$/.exec(
    url.pathname,
  );
  if (match && req.method === 'GET' && !match[2]) {
    session = decodeURIComponent(match[1]);
    return json(
      res,
      200,
      sessionBody(
        scenario === 'setup-mismatch' ? 'other' : session,
        directory,
        false,
      ),
    );
  }
  if (match?.[2] === '/prompt_async' && req.method === 'POST') {
    const body = await read(req);
    if (decodeURIComponent(match[1]) !== session || !body?.messageID)
      return json(res, 400, {});
    parent = body.messageID;
    res.writeHead(204);
    res.end();
    setImmediate(() => {
      if (scenario === 'success') complete();
      else if (scenario === 'permission')
        emit('permission.asked', {
          id: 'permission-1',
          sessionID: session,
          permission: 'bash',
          patterns: ['*'],
          metadata: {},
          always: [],
        });
      else if (scenario === 'error')
        emit('session.error', {
          sessionID: session,
          error: { name: 'UnknownError', data: { message: 'x' } },
        });
      else if (scenario === 'quota-error')
        complete({
          name: 'APIError',
          data: { message: 'x', statusCode: 429, isRetryable: true },
        });
    });
    return;
  }
  if (match?.[2] === '/abort' && req.method === 'POST') {
    json(res, 200, true);
    setImmediate(() =>
      complete({ name: 'MessageAbortedError', data: { message: 'x' } }),
    );
    return;
  }
  if (route === 'POST /permission/permission-1/reply') {
    const body = await read(req);
    if (body?.reply !== 'reject') return json(res, 400, {});
    json(res, 200, true);
    setImmediate(() => complete());
    return;
  }
  json(res, 404, { name: 'NotFoundError' });
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const host = scenario === 'announce-remote' ? '0.0.0.0' : '127.0.0.1';
  process.stdout.write(`opencode server listening on http://${host}:${port}\n`);
});
// Owned shutdown: stdin EOF ends event streams and exits cleanly.
createInterface({ input: process.stdin }).on('close', () => {
  for (const res of streams) res.end();
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
