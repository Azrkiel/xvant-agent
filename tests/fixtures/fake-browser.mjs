import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Minimal Chrome DevTools Protocol peer for browser.inspect tests. It honors
// --user-data-dir and --remote-debugging-port=0 like Chromium: it writes
// DevToolsActivePort into the profile and serves one page target over WebSocket.
const flag = (name) =>
  process.argv
    .find((arg) => arg.startsWith(name + '='))
    ?.slice(name.length + 1);
const profile = flag('--user-data-dir');
if (process.env.FAKE_BROWSER_ARGS_OUT)
  writeFileSync(
    process.env.FAKE_BROWSER_ARGS_OUT,
    JSON.stringify(process.argv.slice(2)),
  );
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const server = createServer((req, res) => {
  if (req.url === '/json/list') {
    const { port } = server.address();
    res.end(
      JSON.stringify([
        {
          type: 'page',
          url: 'about:blank',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
        },
      ]),
    );
    return;
  }
  res.statusCode = 404;
  res.end();
});
let socket;
const send = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  const header =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : body.length < 65536
        ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
        : null;
  socket.write(Buffer.concat([header, body]));
};
const paused = new Map();
let pausedId = 0;
let navigation;
function request(url) {
  const requestId = 'r' + ++pausedId;
  return new Promise((resolve) => {
    paused.set(requestId, resolve);
    send({
      method: 'Fetch.requestPaused',
      params: {
        requestId,
        request: { url, method: 'GET' },
        resourceType: 'Document',
      },
    });
  });
}
async function navigate(url) {
  const main = await request(url);
  if (main !== 'continue') return;
  send({
    method: 'Network.responseReceived',
    params: { type: 'Document', response: { url, status: 200 } },
  });
  await request('http://evil.example/steal.js');
  send({
    method: 'Runtime.consoleAPICalled',
    params: {
      type: 'error',
      args: [{ type: 'string', value: 'boom at load' }],
    },
  });
  if (!url.includes('/hang'))
    send({ method: 'Page.loadEventFired', params: {} });
  navigation = url;
}
function handle(message) {
  const { id, method, params } = message;
  const reply = (result = {}) => send({ id, result });
  if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
    reply();
    paused.get(params.requestId)?.(
      method === 'Fetch.continueRequest' ? 'continue' : 'fail',
    );
    return;
  }
  if (method === 'Page.navigate') {
    reply({ frameId: 'f1' });
    void navigate(params.url);
    return;
  }
  if (method === 'Runtime.evaluate')
    return reply({
      result: {
        type: 'object',
        value: {
          title: 'Fake Title',
          url: navigation,
          text: 'Hello from the fake page. token=ghp_' + 'f4'.repeat(18),
        },
      },
    });
  if (method === 'Page.captureScreenshot')
    return reply({ data: PNG.toString('base64') });
  reply();
}
server.on('upgrade', (req, sock) => {
  const accept = createHash('sha1')
    .update(
      req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11',
    )
    .digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket = sock;
  let buffer = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 15;
      let length = buffer[1] & 127;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(
        buffer.subarray(offset + 4, offset + 4 + length),
      );
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 8) return sock.end();
      if (opcode === 1) handle(JSON.parse(payload.toString('utf8')));
    }
  });
  sock.on('error', () => {});
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(
    join(profile, 'DevToolsActivePort'),
    server.address().port + '\n/devtools/browser/fake\n',
  );
});
