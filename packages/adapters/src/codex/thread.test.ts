import { expect, it } from 'vitest';
import { CodexLifecycle } from './lifecycle.ts';
import { CODEX_VERSION, validateNative } from './profile.ts';

const cwd = process.cwd();
function ready(id?: string) {
  const life = new CodexLifecycle(CODEX_VERSION, id);
  life.initialize();
  life.initialized({
    userAgent: 'fixture',
    codexHome: cwd,
    platformFamily: 'fixture',
    platformOs: 'fixture',
  });
  return life;
}
function response(id = 'thread-1') {
  return {
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    cwd,
    model: 'fixture',
    modelProvider: 'fixture',
    sandbox: { type: 'readOnly' },
    thread: {
      id,
      cliVersion: CODEX_VERSION,
      createdAt: 1,
      updatedAt: 1,
      cwd,
      ephemeral: false,
      modelProvider: 'fixture',
      preview: '',
      projectId: null,
      sessionId: 'session-1',
      source: 'appServer',
      status: { type: 'idle' },
      turns: [],
    },
  };
}
it.each(['ThreadStartResponse', 'ThreadResumeResponse'])(
  'pins and validates %s',
  (name) => {
    expect(() => validateNative(name, response())).not.toThrow();
    expect(() => validateNative(name, { thread: { id: 'thread-1' } })).toThrow(
      'INVALID_EVENT',
    );
  },
);
it.each(['create', 'resume'] as const)(
  'requires explicit %s handshake before a turn',
  (mode) => {
    const life = ready(mode === 'resume' ? 'thread-1' : undefined);
    const request = life.openThread(mode, cwd);
    expect(request.method).toBe(
      mode === 'create' ? 'thread/start' : 'thread/resume',
    );
    expect(request.params).toMatchObject({
      cwd,
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
    });
    if (mode === 'resume')
      expect(request.params).toMatchObject({
        threadId: 'thread-1',
        excludeTurns: true,
      });
    expect(() => life.start('too early')).toThrow();
    life.threadOpened(response());
    expect(life.nativeSessionId).toBe('thread-1');
    expect(life.start('fixture').params.threadId).toBe('thread-1');
    expect(() => life.openThread(mode, cwd)).toThrow();
  },
);
it('correlates thread-start notifications that precede the reply', () => {
  const life = ready();
  life.openThread('create', cwd);
  expect(
    life.message({
      method: 'thread/started',
      params: { thread: response().thread },
    }),
  ).toEqual({ kind: 'ignored' });
  expect(() => life.threadOpened(response('other'))).toThrow('INVALID_EVENT');
  expect(life.status).toBe('needs_attention');
});
it('correlates a delayed thread-start notification after turn dispatch', () => {
  const life = ready();
  life.openThread('create', cwd);
  life.threadOpened(response());
  life.start('task');
  expect(
    life.message({
      method: 'thread/started',
      params: { thread: response().thread },
    }),
  ).toEqual({ kind: 'ignored' });
  expect(() =>
    life.message({
      method: 'thread/started',
      params: { thread: response('other').thread },
    }),
  ).toThrow('INVALID_EVENT');
});
it.each(['wrong-id', 'cwd', 'policy', 'active', 'version', 'invalid'])(
  'rejects unsafe thread response: %s',
  (scenario) => {
    const life = ready('thread-1');
    life.openThread('resume', cwd);
    const value = response(scenario === 'wrong-id' ? 'other' : 'thread-1');
    if (scenario === 'cwd') value.cwd = cwd + '/other';
    if (scenario === 'policy') value.approvalPolicy = 'never';
    if (scenario === 'active') value.thread.status.type = 'systemError';
    if (scenario === 'version') value.thread.cliVersion = 'other';
    expect(() =>
      life.threadOpened(scenario === 'invalid' ? {} : value),
    ).toThrow('INVALID_EVENT');
    expect(life.status).toBe('needs_attention');
    expect(() => life.start('retry')).toThrow();
  },
);
it('rejects invalid mode, relative workspace and implicit creation', () => {
  expect(() => ready().start('task')).toThrow();
  expect(() => ready().openThread('resume', cwd)).toThrow();
  expect(() => ready('thread-1').openThread('create', cwd)).toThrow();
  expect(() => ready().openThread('create', 'relative')).toThrow();
});
it.each([false, true])(
  'fails closed on native errors including willRetry=%s',
  (willRetry) => {
    const life = ready('thread-1');
    life.start('task');
    life.started({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
    expect(() =>
      life.message({
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          error: {
            message: 'fixture error',
            codexErrorInfo: 'usageLimitExceeded',
          },
          willRetry,
        },
      }),
    ).toThrow('WORKER_FAILED');
    expect(life.status).toBe('needs_attention');
    expect(() => life.start('retry')).toThrow();
  },
);
