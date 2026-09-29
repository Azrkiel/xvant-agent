import { expect, it } from 'vitest';
import { NativeLifecycle } from './native-lifecycle.ts';
import type { StreamKind } from './native-profiles.ts';

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'session',
  uuid: 'init-message',
  apiKeySource: 'none',
  claude_code_version: '2.1.283',
  cwd: '/work',
  tools: [],
  mcp_servers: [],
  model: 'fixture',
  permissionMode: 'plan',
  slash_commands: [],
  output_style: 'default',
  skills: [],
  plugins: [],
  capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
};
const setupReply = (kind: StreamKind) =>
  kind === 'claude'
    ? {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'setup',
          pending_permission_requests: [],
          pending_user_dialog_requests: [],
          response: {
            commands: [],
            agents: [],
            output_style: 'default',
            available_output_styles: [],
            models: [],
            account: {},
          },
        },
      }
    : {
        fixture: 'http-response',
        requestId: 'setup',
        method: 'GET',
        path: '/session/session',
        status: 200,
        body: {
          id: 'session',
          slug: 'fixture',
          projectID: 'project',
          directory: '/work',
          title: 'fixture',
          version: 'fixture',
          time: { created: 1, updated: 1 },
        },
      };
const interruptReply = (kind: StreamKind) =>
  kind === 'claude'
    ? {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'interrupt',
          response: { still_queued: [], cancelled: [] },
        },
      }
    : {
        fixture: 'http-response',
        requestId: 'interrupt',
        method: 'POST',
        path: '/session/session/abort',
        status: 200,
        body: true,
      };
function started(kind: StreamKind) {
  const life = new NativeLifecycle(kind, 'session', 'attempt', '/work');
  life.setup();
  life.receive(setupReply(kind));
  life.start();
  if (kind === 'claude') life.receive(init);
  return life;
}
for (const kind of ['claude', 'opencode'] as const) {
  it(`${kind}: requires setup before dispatch and correlates interruption`, () => {
    const life = new NativeLifecycle(kind, 'session', 'attempt', '/work');
    expect(() => life.start()).toThrow('INVALID_EVENT');
    const clean = new NativeLifecycle(kind, 'session', 'attempt', '/work');
    expect(clean.setup()).toMatchObject(
      kind === 'claude'
        ? { type: 'control_request', request: { subtype: 'initialize' } }
        : { method: 'GET', path: '/session/session' },
    );
    expect(clean.receive(setupReply(kind))).toBe(true);
    expect(clean.ready).toBe(true);
    clean.start();
    if (kind === 'claude') clean.receive(init);
    expect(clean.interrupt()).toMatchObject(
      kind === 'claude'
        ? { request: { subtype: 'interrupt', cancel_queued: true } }
        : { method: 'POST', path: '/session/session/abort' },
    );
    expect(clean.interrupted).toBe(false);
    expect(clean.receive(interruptReply(kind))).toBe(true);
    expect(clean.interrupted).toBe(true);
    expect(() => clean.interrupt()).toThrow('INVALID_EVENT');
  });
  it(`${kind}: rejects replayed setup replies`, () => {
    const life = started(kind);
    expect(() => life.receive(setupReply(kind))).toThrow('INVALID_EVENT');
  });
  it(`${kind}: rejects unsolicited interrupt receipts`, () => {
    expect(() => started(kind).receive(interruptReply(kind))).toThrow(
      'INVALID_EVENT',
    );
  });
  it(`${kind}: rejects wrong interrupt correlation`, () => {
    const life = started(kind);
    life.interrupt();
    const reply = JSON.parse(JSON.stringify(interruptReply(kind)));
    if (kind === 'claude') reply.response.request_id = 'other';
    else reply.path = '/session/other/abort';
    expect(() => life.receive(reply)).toThrow('INVALID_EVENT');
  });
  it(`${kind}: rejects missing or unsuccessful interruption receipts`, () => {
    const life = started(kind);
    life.interrupt();
    const reply = JSON.parse(JSON.stringify(interruptReply(kind)));
    if (kind === 'claude') delete reply.response.response.still_queued;
    else reply.body = false;
    expect(() => life.receive(reply)).toThrow('INVALID_EVENT');
  });
}
it.each(['session_id', 'cwd', 'permissionMode', 'claude_code_version'])(
  'rejects unsafe Claude init %s',
  (field) => {
    const life = new NativeLifecycle('claude', 'session', 'attempt', '/work');
    life.setup();
    life.receive(setupReply('claude'));
    life.start();
    expect(() => life.receive({ ...init, [field]: 'other' })).toThrow(
      'INVALID_EVENT',
    );
  },
);
it('rejects Claude terminal output before init metadata', () => {
  const life = new NativeLifecycle('claude', 'session', 'attempt', '/work');
  life.setup();
  life.receive(setupReply('claude'));
  life.start();
  expect(() => life.receive({ type: 'result' })).toThrow('INVALID_EVENT');
});
it('rejects Claude pending inherited permissions', () => {
  const life = new NativeLifecycle('claude', 'session', 'attempt', '/work');
  life.setup();
  const reply = JSON.parse(JSON.stringify(setupReply('claude')));
  reply.response.pending_permission_requests = [{ request_id: 'old' }];
  expect(() => life.receive(reply)).toThrow('INVALID_EVENT');
});
it('rejects queued survivors after a Claude interrupt', () => {
  const life = started('claude');
  life.interrupt();
  const reply = JSON.parse(JSON.stringify(interruptReply('claude')));
  reply.response.response.still_queued = ['other'];
  expect(() => life.receive(reply)).toThrow('INVALID_EVENT');
});
it.each(['id', 'directory'])(
  'rejects mismatched OpenCode session %s',
  (field) => {
    const life = new NativeLifecycle('opencode', 'session', 'attempt', '/work');
    life.setup();
    const reply = JSON.parse(JSON.stringify(setupReply('opencode')));
    reply.body[field] = 'other';
    expect(() => life.receive(reply)).toThrow('INVALID_EVENT');
  },
);
it('requires advertised Claude interrupt receipt and queue cancellation support', () => {
  const life = new NativeLifecycle('claude', 'session', 'attempt', '/work');
  life.setup();
  life.receive(setupReply('claude'));
  life.start();
  life.receive({ ...init, capabilities: [] });
  expect(life.canInterrupt).toBe(false);
  expect(() => life.interrupt()).toThrow('INVALID_EVENT');
});
it('does not recover a poisoned lifecycle with a later valid reply', () => {
  const life = new NativeLifecycle('opencode', 'session', 'attempt', '/work');
  life.setup();
  expect(() => life.receive({ type: 'unexpected' })).toThrow('INVALID_EVENT');
  expect(() => life.receive(setupReply('opencode'))).toThrow('INVALID_EVENT');
});
it('encodes the selected OpenCode session in the request path', () => {
  const life = new NativeLifecycle(
    'opencode',
    'session/other',
    'attempt',
    '/work',
  );
  expect(life.setup()).toMatchObject({
    path: '/session/session%2Fother',
    query: { directory: '/work' },
  });
});
const createdReply = () => ({
  fixture: 'http-response',
  requestId: 'setup',
  method: 'POST',
  path: '/session',
  status: 200,
  body: {
    id: 'created',
    slug: 'fixture',
    projectID: 'project',
    directory: '/work',
    title: 'fixture',
    version: 'fixture',
    permission: [{ permission: '*', pattern: '*', action: 'deny' }],
    time: { created: 1, updated: 1 },
  },
});
it('uses the created OpenCode session for subsequent aborts', () => {
  const life = new NativeLifecycle(
    'opencode',
    'pending:connection',
    'attempt',
    '/work',
    'create',
  );
  expect(life.setup()).toMatchObject({
    method: 'POST',
    path: '/session',
    body: { permission: [{ permission: '*', pattern: '*', action: 'deny' }] },
  });
  life.receive(createdReply());
  expect(life.nativeSessionId).toBe('created');
  life.start();
  expect(life.interrupt()).toMatchObject({ path: '/session/created/abort' });
});
it.each([
  'parentID',
  'revert',
  'archived',
  'permissions',
  'pending-id',
  'wrong-path',
])('rejects unsafe created session %s', (field) => {
  const life = new NativeLifecycle(
    'opencode',
    'pending:connection',
    'attempt',
    '/work',
    'create',
  );
  life.setup();
  const reply = JSON.parse(JSON.stringify(createdReply()));
  if (field === 'archived') reply.body.time.archived = 2;
  else if (field === 'permissions')
    reply.body.permission.push({
      permission: 'bash',
      pattern: '*',
      action: 'allow',
    });
  else if (field === 'pending-id') reply.body.id = 'pending:other';
  else if (field === 'wrong-path') reply.path = '/session/other';
  else reply.body[field] = 'other';
  expect(() => life.receive(reply)).toThrow('INVALID_EVENT');
  expect(life.ready).toBe(false);
});
it('does not invent a Claude control creation request', () => {
  expect(
    () =>
      new NativeLifecycle(
        'claude',
        'pending:connection',
        'attempt',
        '/work',
        'create',
      ),
  ).toThrow('MODE_UNSUPPORTED');
});
for (const kind of ['claude', 'opencode'] as const)
  it(`${kind}: reports interrupt support only for a running turn`, () => {
    const life = new NativeLifecycle(kind, 'session', 'attempt', '/work');
    expect(life.interruptSupport).toBe('pending');
    life.setup();
    life.receive(setupReply(kind));
    expect(life.interruptSupport).toBe('pending');
    life.start();
    expect(life.interruptSupport).toBe(kind === 'claude' ? 'pending' : 'ready');
    if (kind === 'claude') life.receive(init);
    expect(life.interruptSupport).toBe('ready');
    life.interrupt();
    expect(life.interruptSupport).toBe('closed');
  });
it('reports Claude interrupt as unsupported without receipt capabilities', () => {
  const life = new NativeLifecycle('claude', 'session', 'attempt', '/work');
  life.setup();
  life.receive(setupReply('claude'));
  life.start();
  life.receive({ ...init, capabilities: ['interrupt_receipt_v1'] });
  expect(life.interruptSupport).toBe('unsupported');
  expect(() => life.interrupt()).toThrow('INVALID_EVENT');
});
it('closes interrupt support after an invalid event', () => {
  const life = started('opencode');
  expect(() => life.receive(interruptReply('opencode'))).toThrow();
  expect(life.interruptSupport).toBe('closed');
});
