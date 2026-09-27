import { describe, expect, it } from 'vitest';
import { CodexLifecycle } from './lifecycle.ts';
import { CODEX_VERSION } from './profile.ts';

const turn = (id = 'turn-1', status = 'inProgress') => ({
  id,
  status,
  items: [],
});
function ready() {
  const lifecycle = new CodexLifecycle(CODEX_VERSION, 'thread-1');
  lifecycle.initialize();
  lifecycle.initialized({
    userAgent: 'fixture',
    codexHome: 'C:/fixture',
    platformFamily: 'windows',
    platformOs: 'windows',
  });
  return lifecycle;
}
describe('Codex lifecycle boundary', () => {
  it('rejects unpinned versions and turns before initialization', () => {
    expect(() => new CodexLifecycle('newer', 'thread-1')).toThrow(
      'VERSION_UNSUPPORTED',
    );
    expect(() =>
      new CodexLifecycle(CODEX_VERSION, 'thread-1').start('task'),
    ).toThrow('ILLEGAL_TRANSITION');
  });
  it('validates handshake and sends explicit thread and read-only turn policy', () => {
    const life = ready();
    const request = life.start('Read the fixture');
    expect(request.method).toBe('turn/start');
    expect(request.params).toMatchObject({
      threadId: 'thread-1',
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly' },
    });
    expect(() => life.start('duplicate')).toThrow('WORKER_BUSY');
    life.started({ turn: turn() });
    expect(life.status).toBe('running');
  });
  it('accepts a turn-start notification before its RPC acknowledgement', () => {
    const life = ready();
    life.start('task');
    expect(
      life.message({
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: turn() },
      }),
    ).toEqual({ kind: 'started', nativeRunId: 'turn-1' });
    life.started({ turn: turn() });
    expect(life.status).toBe('running');
  });
  it('correlates output and holds terminal work for host verification', () => {
    const life = ready();
    life.start('task');
    life.started({ turn: turn() });
    expect(
      life.message({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: 'text',
        },
      }),
    ).toEqual({ kind: 'output', text: 'text' });
    expect(
      life.message({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: turn('turn-1', 'completed') },
      }),
    ).toEqual({ kind: 'completed' });
    expect(life.status).toBe('result_pending');
    expect(() => life.start('next')).toThrow('WORKER_BUSY');
  });
  it.each([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
  ])('denies %s without exposing an approval capability', (method) => {
    const life = ready();
    life.start('task');
    life.started({ turn: turn() });
    const result = life.message({
      id: 'server-1',
      method,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        startedAtMs: 1,
      },
    });
    expect(result).toEqual({
      kind: 'deny',
      id: 'server-1',
      result: { decision: 'decline' },
    });
  });
  it('marks interruption pending until a terminal event and never resumes on disconnect', () => {
    const life = ready();
    life.start('task');
    life.started({ turn: turn() });
    expect(life.interrupt()).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(life.status).toBe('interrupt_requested');
    life.disconnected();
    expect(life.status).toBe('needs_attention');
    life.message({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('turn-1', 'interrupted') },
    });
    expect(life.status).toBe('needs_attention');
    expect(() => life.start('retry')).toThrow('WORKER_BUSY');
  });
  it('rejects wrong session, run, schema and unsupported server methods', () => {
    for (const message of [
      {
        method: 'turn/completed',
        params: { threadId: 'other', turn: turn('turn-1', 'completed') },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: turn('other', 'completed') },
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed' },
        },
      },
      {
        id: 'approval',
        method: 'item/permissions/requestApproval',
        params: {},
      },
    ]) {
      const life = ready();
      life.start('task');
      life.started({ turn: turn() });
      expect(() => life.message(message)).toThrow();
      expect(life.status).toBe('needs_attention');
    }
  });
  it('rejects oversized output and post-terminal events', () => {
    const life = ready();
    life.start('task');
    life.started({ turn: turn() });
    expect(() =>
      life.message({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'i',
          delta: 'x'.repeat(16385),
        },
      }),
    ).toThrow('LIMIT_EXCEEDED');
    const done = ready();
    done.start('task');
    done.started({ turn: turn() });
    done.message({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('turn-1', 'completed') },
    });
    expect(() =>
      done.message({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: turn('turn-1', 'completed') },
      }),
    ).toThrow('INVALID_EVENT');
  });
});
