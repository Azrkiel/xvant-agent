import { describe, expect, it } from 'vitest';
import { OpenCodeCliStream, OPENCODE_CLI_VERSION } from './cli-stream.ts';
const start = () => ({
  type: 'step_start',
  timestamp: 10,
  sessionID: 'ses_a',
  part: {
    id: 'part_start',
    sessionID: 'ses_a',
    messageID: 'msg_a',
    type: 'step-start',
    snapshot: 'abc',
  },
});
const text = () => ({
  type: 'text',
  timestamp: 20,
  sessionID: 'ses_a',
  part: {
    id: 'part_text',
    sessionID: 'ses_a',
    messageID: 'msg_a',
    type: 'text',
    text: 'hello 世界',
    time: { start: 11, end: 20 },
  },
});
const wire = (...events: unknown[]) =>
  Buffer.from(events.map((x) => JSON.stringify(x) + '\n').join(''));
describe('OpenCode 2 CLI framing', () => {
  it('pins the qualified CLI and correlates arbitrarily split UTF-8 output', () => {
    expect(OPENCODE_CLI_VERSION).toBe('2.0.19');
    const frames: unknown[] = [];
    const stream = new OpenCodeCliStream('ses_a', (x) => {
      frames.push(x);
    });
    for (const byte of wire(start(), text()))
      stream.receive(Buffer.from([byte]));
    expect(stream.end()).toEqual({
      kind: 'completed',
      nativeMessageId: 'msg_a',
      text: 'hello 世界',
    });
    expect(frames).toEqual([start(), text()]);
    expect(() => stream.receive(wire(text()))).toThrow('CONNECTION_CLOSED');
  });
  it.each([
    { ...text(), sessionID: 'ses_wrong' },
    { ...text(), part: { ...text().part, sessionID: 'ses_wrong' } },
    { ...text(), part: { ...text().part, messageID: 'msg_wrong' } },
    { ...text(), part: { ...text().part, time: { start: 20, end: 10 } } },
    { ...text(), part: { ...text().part, text: '' } },
    { ...text(), extra: true },
    { type: 'tool_use', sessionID: 'ses_a' },
    start(),
  ])('rejects invalid identity, shape, or ordering before callback', (bad) => {
    const seen: unknown[] = [];
    const stream = new OpenCodeCliStream('ses_a', (x) => {
      seen.push(x);
    });
    stream.receive(wire(start()));
    expect(() => stream.receive(wire(bad))).toThrow('INVALID_EVENT');
    expect(seen).toEqual([start()]);
    expect(() => stream.end()).toThrow();
  });
  it('requires a start and completed text; rejects repeated text identities', () => {
    expect(() => new OpenCodeCliStream('ses_a').receive(wire(text()))).toThrow(
      'INVALID_EVENT',
    );
    const stream = new OpenCodeCliStream('ses_a');
    stream.receive(wire(start()));
    expect(() => stream.end()).toThrow('OPERATION_UNKNOWN');
    const repeated = new OpenCodeCliStream('ses_a');
    repeated.receive(wire(start(), text()));
    expect(() => repeated.receive(wire(text()))).toThrow('INVALID_EVENT');
  });
  it('rejects malformed, truncated, oversized and aggregate unbounded input', () => {
    expect(() =>
      new OpenCodeCliStream('ses_a').receive(Buffer.from('{bad}\n')),
    ).toThrow();
    const truncated = new OpenCodeCliStream('ses_a');
    truncated.receive(Buffer.from('{'));
    expect(() => truncated.end()).toThrow('OPERATION_UNKNOWN');
    expect(() =>
      new OpenCodeCliStream('ses_a').receive(Buffer.alloc(65537, 32)),
    ).toThrow('LIMIT_EXCEEDED');
    const aggregate = new OpenCodeCliStream('ses_a');
    aggregate.receive(wire(start()));
    expect(() => aggregate.receive(Buffer.alloc(1048577))).toThrow(
      'LIMIT_EXCEEDED',
    );
  });
  it.each([
    ['provider.auth', undefined, 'AUTH_REQUIRED', 'quota_group'],
    ['unknown', 429, 'QUOTA_BLOCKED', 'quota_group'],
    ['unknown', 403, 'WORKER_FAILED', 'attempt'],
    ['unknown', undefined, 'WORKER_FAILED', 'attempt'],
  ] as const)(
    'classifies codes without trusting error text: %s/%s',
    (type, status, code, scope) => {
      const stream = new OpenCodeCliStream('ses_a');
      stream.receive(
        wire({
          type: 'error',
          timestamp: 10,
          sessionID: 'ses_a',
          error: {
            type,
            message: 'auth quota 429 secret',
            ...(status === undefined ? {} : { status }),
          },
        }),
      );
      expect(stream.failure).toMatchObject({ code, scope });
      const result = stream.end();
      expect(result).toMatchObject({
        kind: 'failed',
        text: '',
        failure: { code, scope },
      });
      expect(result.nativeMessageId).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('secret');
    },
  );
  it('retains known identity on an error but rejects traffic after it', () => {
    const error = {
      type: 'error',
      timestamp: 20,
      sessionID: 'ses_a',
      error: { type: 'unknown', message: 'failure' },
    };
    const stream = new OpenCodeCliStream('ses_a');
    stream.receive(wire(start(), error));
    expect(stream.end()).toMatchObject({
      kind: 'failed',
      nativeMessageId: 'msg_a',
    });
    const extra = new OpenCodeCliStream('ses_a');
    extra.receive(wire(error));
    expect(() => extra.receive(wire(start()))).toThrow('INVALID_EVENT');
  });
  it('poisons the stream when the persistence barrier throws or returns a promise', () => {
    const rejected = new OpenCodeCliStream('ses_a', () => {
      throw new Error('storage failed');
    });
    expect(() => rejected.receive(wire(start()))).toThrow('storage failed');
    expect(() => rejected.end()).toThrow();
    const asynchronous = new OpenCodeCliStream('ses_a', async () => {});
    expect(() => asynchronous.receive(wire(start()))).toThrow(
      'INVALID_PERSISTENCE_BARRIER',
    );
  });
});

describe('OpenCode CLI bounded stream edges', () => {
  it('accumulates distinct completed parts in wire order', () => {
    const stream = new OpenCodeCliStream('ses_a');
    stream.receive(
      wire(start(), text(), {
        ...text(),
        part: { ...text().part, id: 'part_second', text: '!' },
      }),
    );
    expect(stream.end()).toMatchObject({
      kind: 'completed',
      text: 'hello 世界!',
    });
  });
  it('bounds total bytes even when every individual frame is valid', () => {
    const stream = new OpenCodeCliStream('ses_a');
    stream.receive(wire(start()));
    for (let i = 0; i < 17; i++)
      stream.receive(
        wire({
          ...text(),
          part: { ...text().part, id: `part_${i}`, text: 'a'.repeat(60000) },
        }),
      );
    expect(() =>
      stream.receive(
        wire({
          ...text(),
          part: { ...text().part, id: 'part_final', text: 'a'.repeat(60000) },
        }),
      ),
    ).toThrow('LIMIT_EXCEEDED');
    expect(() => stream.end()).toThrow('OPERATION_UNKNOWN');
  });
  it('rejects invalid UTF-8, unknown error codes, and blank final output', () => {
    const utf8 = Buffer.concat([
      Buffer.from('{"x":"'),
      Buffer.from([0xff]),
      Buffer.from('"}\n'),
    ]);
    expect(() => new OpenCodeCliStream('ses_a').receive(utf8)).toThrow(
      'INVALID_EVENT',
    );
    expect(() =>
      new OpenCodeCliStream('ses_a').receive(
        wire({
          type: 'error',
          timestamp: 20,
          sessionID: 'ses_a',
          error: { type: 'quota_auth_magic', message: 'fake' },
        }),
      ),
    ).toThrow('INVALID_EVENT');
    const blank = new OpenCodeCliStream('ses_a');
    blank.receive(
      wire(start(), { ...text(), part: { ...text().part, text: ' ' } }),
    );
    expect(() => blank.end()).toThrow('OPERATION_UNKNOWN');
  });
  it('callback mutation cannot change the parsed identity or output', () => {
    const stream = new OpenCodeCliStream('ses_a', (frame) => {
      frame.sessionID = 'other';
      (frame.part as Record<string, unknown>).text = 'changed';
    });
    stream.receive(wire(start(), text()));
    expect(stream.end()).toMatchObject({
      kind: 'completed',
      text: 'hello 世界',
      nativeMessageId: 'msg_a',
    });
  });
});
