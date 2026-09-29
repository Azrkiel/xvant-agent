import { expect, it } from 'vitest';
import { NativeStream, SseDecoder } from './native-stream.ts';
import { versions, validateMessage, pins } from './native-profiles.ts';

it('does not deliver controls when the receive journal fails', () => {
  let delivered = false;
  const stream = new NativeStream(
    'claude',
    versions.claude,
    'session',
    'request',
    {
      beforeReceive: () => {
        throw new Error('DISK_FAILURE');
      },
      handleControl: () => {
        delivered = true;
        return true;
      },
    },
  );
  expect(() =>
    stream.receive(Buffer.from('{"type":"control_response"}\n')),
  ).toThrow('DISK_FAILURE');
  expect(delivered).toBe(false);
});
it('rejects an asynchronous control handler', () => {
  const stream = new NativeStream(
    'claude',
    versions.claude,
    'session',
    'request',
    {
      handleControl: (() =>
        Promise.reject(new Error('ASYNC_HANDLER'))) as unknown as () => boolean,
    },
  );
  expect(() =>
    stream.receive(Buffer.from('{"type":"control_response"}\n')),
  ).toThrow('INVALID_PERSISTENCE_BARRIER');
  expect(stream.status).toBe('needs_attention');
});
it('binds a provisional stream once and uses the new session for results', () => {
  const stream = new NativeStream(
    'opencode',
    versions.opencode,
    'pending:connection',
    'request-1',
  );
  stream.bindSession('session-1');
  stream.receive(frame('opencode', result('opencode')));
  expect(stream.end().sessionId).toBe('session-1');
});
it.each(['existing', 'twice', 'after-message', 'closed'])(
  'rejects stream binding %s',
  (mode) => {
    const stream = new NativeStream(
      'opencode',
      versions.opencode,
      mode === 'existing' ? 'existing' : 'pending:connection',
      'request-1',
    );
    if (mode === 'twice') stream.bindSession('first');
    if (mode === 'after-message')
      stream.receive(
        frame('opencode', {
          id: 'idle',
          type: 'session.idle',
          properties: { sessionID: 'pending:connection' },
        }),
      );
    if (mode === 'closed') stream.cancel();
    expect(() => stream.bindSession('second')).toThrow('INVALID_EVENT');
    expect(stream.status).toBe('needs_attention');
  },
);

const session = 'session-1',
  request = 'request-1';
function result(kind: 'claude' | 'opencode') {
  return kind === 'claude'
    ? {
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        result: 'fixture',
        uuid: 'result-1',
        session_id: session,
        user_message_uuid: request,
      }
    : {
        id: 'event-1',
        type: 'message.updated',
        properties: {
          sessionID: session,
          info: {
            id: 'assistant-1',
            sessionID: session,
            parentID: request,
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
          },
        },
      };
}
const frame = (kind: 'claude' | 'opencode', value: unknown) =>
  Buffer.from(
    kind === 'claude'
      ? JSON.stringify(value) + '\n'
      : 'data: ' + JSON.stringify(value) + '\r\n\r\n',
  );
it.each(['claude', 'opencode'] as const)(
  'persists %s envelopes before interpretation',
  (kind) => {
    const messages: unknown[] = [];
    const stream = new NativeStream(kind, versions[kind], session, request, {
      beforeReceive: (message) => {
        expect(stream.status).toBe('running');
        messages.push(message);
        throw new Error('DISK_FAILURE');
      },
    });
    expect(() => stream.receive(frame(kind, result(kind)))).toThrow(
      'DISK_FAILURE',
    );
    expect(messages).toEqual([result(kind)]);
    expect(stream.status).toBe('needs_attention');
    expect(() => stream.end()).toThrow('OPERATION_UNKNOWN');
  },
);
it.each(['claude', 'opencode'] as const)(
  'rejects asynchronous %s persistence barriers',
  (kind) => {
    const stream = new NativeStream(kind, versions[kind], session, request, {
      beforeReceive: async () => {
        throw new Error('DISK_FAILURE');
      },
    });
    expect(() => stream.receive(frame(kind, result(kind)))).toThrow(
      'INVALID_PERSISTENCE_BARRIER',
    );
    expect(stream.status).toBe('needs_attention');
  },
);
it('enforces every required pinned result and assistant field', () => {
  for (const [kind, name] of [
    ['claude', 'SDKResultSuccess'],
    ['opencode', 'AssistantMessage'],
  ] as const) {
    for (const field of pins[kind].declarations[name]!.filter(
      (field) => field.required,
    )) {
      const value = JSON.parse(JSON.stringify(result(kind))) as Record<
        string,
        unknown
      >;
      const target =
        kind === 'claude'
          ? value
          : (value.properties as { info: Record<string, unknown> }).info;
      delete target[field.name];
      expect(() => validateMessage(kind, value), field.name).toThrow(
        'INVALID_EVENT',
      );
    }
  }
});
it.each([
  'queued_turn_count',
  'resume_reason',
  'result_index',
  'deferred_tool_use',
  'user_message_uuids',
])('rejects Claude ambiguous continuation field %s', (field) => {
  const value = {
    ...result('claude'),
    [field]:
      field === 'resume_reason'
        ? 'restarted'
        : field === 'user_message_uuids'
          ? ['other']
          : 1,
  };
  const stream = new NativeStream('claude', versions.claude, session, request);
  expect(() => stream.receive(frame('claude', value))).toThrow('INVALID_EVENT');
});
it('keeps failed Claude results and OpenCode assistant errors failed', () => {
  const claude = new NativeStream('claude', versions.claude, session, request);
  claude.receive(
    frame('claude', {
      ...result('claude'),
      subtype: 'error_max_turns',
      errors: ['fixture'],
    }),
  );
  expect(claude.end().kind).toBe('failed');
  const value = JSON.parse(JSON.stringify(result('opencode')));
  value.properties.info.error = { name: 'UnknownError', data: {} };
  const opencode = new NativeStream(
    'opencode',
    versions.opencode,
    session,
    request,
  );
  opencode.receive(frame('opencode', value));
  expect(opencode.end().kind).toBe('failed');
});
it('handles SSE comments and multiline data without reconnecting on retry hints', () => {
  const decoder = new SseDecoder();
  expect(
    decoder.push(
      Buffer.from(
        ': comment\r\n\r\nretry: 1\nid: ignored\ndata: {"text":\ndata: "雪"}\n\n',
      ),
    ),
  ).toEqual([{ text: '雪' }]);
  decoder.end();
  expect(() => decoder.push(Buffer.from('data: {}\n\n'))).toThrow(
    'CONNECTION_CLOSED',
  );
  expect(() => decoder.end()).toThrow('CONNECTION_CLOSED');
});
it('bounds SSE frames and rejects malformed UTF-8 and partial EOF', () => {
  expect(() => new SseDecoder().push(Buffer.alloc(1048577))).toThrow(
    'LIMIT_EXCEEDED',
  );
  expect(() => new SseDecoder().push(Buffer.alloc(65537, 65))).toThrow(
    'LIMIT_EXCEEDED',
  );
  expect(() =>
    new SseDecoder().push(Buffer.from('data: ' + 'x'.repeat(65537) + '\n\n')),
  ).toThrow('LIMIT_EXCEEDED');
  expect(() =>
    new SseDecoder().push(Buffer.from(':x\n\n'.repeat(1025))),
  ).toThrow('LIMIT_EXCEEDED');
  const malformed = new SseDecoder();
  expect(() =>
    malformed.push(Buffer.from([100, 97, 116, 97, 58, 32, 255, 10, 10])),
  ).toThrow();
  expect(() => malformed.push(Buffer.from('\n'))).toThrow('CONNECTION_CLOSED');
  const partial = new SseDecoder();
  partial.push(Buffer.from('data: {}\n'));
  expect(() => partial.end()).toThrow('OPERATION_UNKNOWN');
});
it('exposes a result after confirmed denial and rejects invented acknowledgements', () => {
  const stream = new NativeStream('claude', versions.claude, session, request);
  stream.receive(
    frame('claude', {
      type: 'control_request',
      request_id: 'permission-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: {},
        tool_use_id: 'tool-1',
      },
    }),
  );
  stream.denialWritten('permission-1');
  stream.receive(frame('claude', result('claude')));
  expect(stream.end().kind).toBe('completed');
  expect(() => stream.denialWritten('permission-1')).toThrow(
    'CONNECTION_CLOSED',
  );
  const other = new NativeStream('claude', versions.claude, session, request);
  expect(() => other.denialWritten('invented')).toThrow('INVALID_EVENT');
  expect(other.status).toBe('needs_attention');
});
it('fails closed on unsupported controls and malformed native event envelopes', () => {
  const claude = new NativeStream('claude', versions.claude, session, request);
  expect(() =>
    claude.receive(
      frame('claude', {
        type: 'control_request',
        request_id: 'p',
        request: { subtype: 'request_user_dialog' },
      }),
    ),
  ).toThrow('INVALID_EVENT');
  const opencode = new NativeStream(
    'opencode',
    versions.opencode,
    session,
    request,
  );
  expect(() =>
    opencode.receive(frame('opencode', { type: 'session.idle' })),
  ).toThrow('INVALID_EVENT');
});
it.each(['claude', 'opencode'] as const)(
  'pins %s sources and rejects missing required fields',
  (kind) => {
    expect(pins[kind].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateMessage(kind, result(kind))).not.toThrow();
    expect(() => validateMessage(kind, {})).toThrow('INVALID_EVENT');
    expect(() => new NativeStream(kind, 'other', session, request)).toThrow(
      'VERSION_UNSUPPORTED',
    );
  },
);
it.each(['claude', 'opencode'] as const)(
  'correlates fragmented %s results and requires clean EOF',
  (kind) => {
    const stream = new NativeStream(kind, versions[kind], session, request);
    for (const byte of frame(kind, result(kind)))
      stream.receive(Buffer.from([byte]));
    expect(stream.status).toBe('result_pending');
    expect(stream.end()).toMatchObject({
      kind: 'completed',
      sessionId: session,
      requestId: request,
    });
    expect(() => stream.receive(frame(kind, result(kind)))).toThrow(
      'CONNECTION_CLOSED',
    );
  },
);
it.each(['claude', 'opencode'] as const)(
  'rejects %s mismatches, partial EOF and duplicate terminal messages',
  (kind) => {
    const wrong = JSON.parse(JSON.stringify(result(kind)));
    if (kind === 'claude') wrong.user_message_uuid = 'other';
    else wrong.properties.info.parentID = 'other';
    const stream = new NativeStream(kind, versions[kind], session, request);
    expect(() => stream.receive(frame(kind, wrong))).toThrow('INVALID_EVENT');
    expect(stream.status).toBe('needs_attention');
    const partial = new NativeStream(kind, versions[kind], session, request);
    partial.receive(frame(kind, result(kind)));
    partial.receive(Buffer.from('{'));
    expect(() => partial.end()).toThrow();
    const duplicate = new NativeStream(kind, versions[kind], session, request);
    duplicate.receive(frame(kind, result(kind)));
    expect(() => duplicate.receive(frame(kind, result(kind)))).toThrow(
      'INVALID_EVENT',
    );
  },
);
it.each(['claude', 'opencode'] as const)(
  'denies %s permissions once and never exposes approval',
  (kind) => {
    const stream = new NativeStream(kind, versions[kind], session, request);
    const permission =
      kind === 'claude'
        ? {
            type: 'control_request',
            request_id: 'permission-1',
            request: {
              subtype: 'can_use_tool',
              tool_name: 'Bash',
              input: {},
              tool_use_id: 'tool-1',
            },
          }
        : {
            id: 'event-1',
            type: 'permission.asked',
            properties: {
              id: 'permission-1',
              sessionID: session,
              permission: 'bash',
              patterns: ['*'],
              always: [],
              metadata: {},
            },
          };
    const actions = stream.receive(frame(kind, permission));
    expect(actions).toHaveLength(1);
    expect(JSON.stringify(actions[0])).toContain(
      kind === 'claude' ? 'deny' : 'reject',
    );
    expect(() => stream.receive(frame(kind, permission))).toThrow(
      'INVALID_EVENT',
    );
  },
);
it('does not treat OpenCode idle or a tool-call boundary as completion', () => {
  const stream = new NativeStream(
    'opencode',
    versions.opencode,
    session,
    request,
  );
  stream.receive(
    frame('opencode', {
      id: 'event-1',
      type: 'session.idle',
      properties: { sessionID: session },
    }),
  );
  const message = result('opencode') as {
    properties: { info: { finish: string } };
  };
  message.properties.info.finish = 'tool-calls';
  stream.receive(frame('opencode', message));
  expect(() => stream.end()).toThrow('OPERATION_UNKNOWN');
});
it('requires host confirmation that a denial was written before exposing a result', () => {
  const stream = new NativeStream('claude', versions.claude, session, request);
  stream.receive(
    frame('claude', {
      type: 'control_request',
      request_id: 'permission-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: {},
        tool_use_id: 'tool-1',
      },
    }),
  );
  stream.receive(frame('claude', result('claude')));
  expect(() => stream.end()).toThrow('OPERATION_UNKNOWN');
});
it.each(['claude', 'opencode'] as const)(
  'invalidates %s after cancellation or oversized input',
  (kind) => {
    const cancelled = new NativeStream(kind, versions[kind], session, request);
    cancelled.cancel();
    expect(() => cancelled.receive(frame(kind, result(kind)))).toThrow(
      'CONNECTION_CLOSED',
    );
    expect(() => cancelled.end()).toThrow('OPERATION_UNKNOWN');
    const large = new NativeStream(kind, versions[kind], session, request);
    expect(() => large.receive(Buffer.alloc(1048577))).toThrow(
      'LIMIT_EXCEEDED',
    );
  },
);
