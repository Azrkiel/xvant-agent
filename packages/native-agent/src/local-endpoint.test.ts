import { afterEach, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { LocalEndpointProvider } from './local-endpoint.ts';
import { ModelError } from './model.ts';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
  }
  server = undefined;
});
type Handler = (
  req: IncomingMessage,
  body: unknown,
) => { status?: number; body: unknown; raw?: string; delayMs?: number };
async function serve(handler: Handler) {
  const seen: {
    url: string;
    headers: IncomingMessage['headers'];
    body: unknown;
  }[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ url: req.url!, headers: req.headers, body });
      const out = handler(req, body);
      setTimeout(() => {
        res.writeHead(out.status ?? 200, {
          'content-type': 'application/json',
        });
        res.end(out.raw ?? JSON.stringify(out.body));
      }, out.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: 'http://127.0.0.1:' + port + '/v1', seen };
}
const reply = (message: unknown, finish = 'stop', usage?: unknown) => ({
  choices: [{ message, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

it.each([
  'https://127.0.0.1:1234/v1',
  'http://api.openai.com/v1',
  'http://192.168.1.5:1234/v1',
  'http://user:pw@127.0.0.1:1234/v1',
  'http://127.0.0.1:1234/v1?key=x',
  'not a url',
])('refuses a non-loopback or credentialed endpoint: %s', (baseUrl) => {
  expect(() => new LocalEndpointProvider({ baseUrl, model: 'm' })).toThrow(
    ModelError,
  );
});

it('refuses an unbounded model identifier', () => {
  expect(
    () =>
      new LocalEndpointProvider({
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'bad model\n',
      }),
  ).toThrow('Invalid model identifier');
});

it('sends no credentials and maps tools, calls and usage', async () => {
  const { url, seen } = await serve(() => ({
    body: reply(
      {
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'file_read', arguments: '{"path":"a.txt"}' },
          },
          { function: { name: 'file_list', arguments: { path: '.' } } },
        ],
      },
      'tool_calls',
      { prompt_tokens: 10, completion_tokens: 5 },
    ),
  }));
  const provider = new LocalEndpointProvider({
    baseUrl: url,
    model: 'qwen/coder-7b',
    server: 'lmstudio',
  });
  expect(provider.id).toBe('lmstudio:qwen/coder-7b');
  const out = await provider.complete({
    messages: [
      { role: 'system', content: 's' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'p', name: 'file_read', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'p', content: '{"ok":true}' },
    ],
    tools: [{ name: 'file.read', description: 'd', parameters: {} }],
    maxTokens: 100,
  });
  expect(out).toEqual({
    text: '',
    toolCalls: [
      { id: 'c1', name: 'file_read', arguments: '{"path":"a.txt"}' },
      { id: 'call_1', name: 'file_list', arguments: '{"path":"."}' },
    ],
    finish: 'tool_calls',
    usage: { inputTokens: 10, outputTokens: 5, source: 'reported' },
  });
  const sent = seen[0]!;
  expect(sent.url).toBe('/v1/chat/completions');
  expect(sent.headers.authorization).toBeUndefined();
  const body = sent.body as Record<string, unknown>;
  expect(body.model).toBe('qwen/coder-7b');
  expect(body.stream).toBe(false);
  expect(
    (body.tools as { function: { name: string } }[])[0]!.function.name,
  ).toBe('file_read');
  expect((body.messages as unknown[])[1]).toMatchObject({
    tool_calls: [{ id: 'p', function: { name: 'file_read' } }],
  });
  expect((body.messages as unknown[])[2]).toEqual({
    role: 'tool',
    tool_call_id: 'p',
    content: '{"ok":true}',
  });
});

it('records missing usage as unknown, never as zero', async () => {
  const { url } = await serve(() => ({
    body: reply({ content: 'done' }, 'weird'),
  }));
  const out = await new LocalEndpointProvider({
    baseUrl: url,
    model: 'm',
  }).complete({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 10,
  });
  expect(out.usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    source: 'unknown',
  });
  expect(out.finish).toBe('other');
});

it.each([
  [{ status: 500, body: {} }, 'MODEL_UNAVAILABLE', true],
  [{ status: 429, body: {} }, 'MODEL_UNAVAILABLE', true],
  [{ status: 400, body: {} }, 'MODEL_UNAVAILABLE', false],
  [{ body: null, raw: 'not json' }, 'MODEL_PROTOCOL', false],
  [{ body: { choices: [] } }, 'MODEL_PROTOCOL', false],
  [
    { body: { choices: [{ message: { content: 1 } }] } },
    'MODEL_PROTOCOL',
    false,
  ],
] as const)('normalizes endpoint failures', async (out, code, transient) => {
  const { url } = await serve(() => out);
  const error = await new LocalEndpointProvider({ baseUrl: url, model: 'm' })
    .complete({ messages: [], tools: [], maxTokens: 1 })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ModelError);
  expect((error as ModelError).code).toBe(code);
  expect((error as ModelError).transient).toBe(transient);
});

it('bounds the response size', async () => {
  const { url } = await serve(() => ({
    body: reply({ content: 'x'.repeat(5000) }),
  }));
  await expect(
    new LocalEndpointProvider({
      baseUrl: url,
      model: 'm',
      maxResponseBytes: 1000,
    }).complete({ messages: [], tools: [], maxTokens: 1 }),
  ).rejects.toMatchObject({ code: 'MODEL_LIMIT' });
});

it('times out and cancels distinctly', async () => {
  const { url } = await serve(() => ({
    body: reply({ content: 'late' }),
    delayMs: 500,
  }));
  const provider = new LocalEndpointProvider({
    baseUrl: url,
    model: 'm',
    timeoutMs: 50,
  });
  await expect(
    provider.complete({ messages: [], tools: [], maxTokens: 1 }),
  ).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', transient: true });
  const controller = new AbortController();
  const slow = new LocalEndpointProvider({ baseUrl: url, model: 'm' });
  const pending = slow.complete(
    { messages: [], tools: [], maxTokens: 1 },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'MODEL_CANCELLED' });
});

it('reports an unreachable endpoint as transient', async () => {
  await expect(
    new LocalEndpointProvider({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'm',
    }).complete({ messages: [], tools: [], maxTokens: 1 }),
  ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', transient: true });
});

it('probes model availability and structured tool calling', async () => {
  let answer: unknown = reply(
    {
      tool_calls: [
        {
          id: 'p',
          function: { name: 'record_number', arguments: '{"value":7}' },
        },
      ],
    },
    'tool_calls',
  );
  const { url } = await serve((req) =>
    req.url === '/v1/models'
      ? {
          body: {
            data: [
              { id: 'other' },
              {
                id: 'm',
                loaded_context_length: 8192,
                max_context_length: 32768,
              },
            ],
          },
        }
      : { body: answer },
  );
  const provider = new LocalEndpointProvider({ baseUrl: url, model: 'm' });
  expect(await provider.probe()).toEqual({
    model: 'm',
    toolCalls: true,
    contextTokens: 8192,
  });
  answer = reply({ content: 'The value is 7.' });
  expect((await provider.probe()).toolCalls).toBe(false);
  answer = reply(
    {
      tool_calls: [{ function: { name: 'record_number', arguments: '{bad' } }],
    },
    'tool_calls',
  );
  expect((await provider.probe()).toolCalls).toBe(false);
  await expect(
    new LocalEndpointProvider({ baseUrl: url, model: 'absent' }).probe(),
  ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
});

it('rejects an unexpected model list', async () => {
  const { url } = await serve(() => ({ body: { models: [] } }));
  await expect(
    new LocalEndpointProvider({ baseUrl: url, model: 'm' }).probe(),
  ).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
});
