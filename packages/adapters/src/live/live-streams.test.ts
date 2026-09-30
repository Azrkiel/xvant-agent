import { describe, expect, it } from 'vitest';
import { OpenCodeRunStream } from './opencode-run.ts';
import { ClaudeHeadlessStream } from './claude-headless.ts';

const S = 'ses_abc';
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const step = (messageID: string) => ({
  type: 'step_start',
  timestamp: 1,
  sessionID: S,
  part: {
    id: 'p' + messageID,
    sessionID: S,
    messageID,
    type: 'step-start',
    snapshot: 'x',
  },
});
const finish = (messageID: string, cost = 0) => ({
  type: 'step_finish',
  timestamp: 2,
  sessionID: S,
  part: {
    id: 'f' + messageID,
    sessionID: S,
    messageID,
    type: 'step-finish',
    reason: 'tool-calls',
    cost,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 1,
      cache: { read: 0, write: 0 },
    },
  },
});
const text = (messageID: string, t: string) => ({
  type: 'text',
  timestamp: 3,
  sessionID: S,
  part: {
    id: 't' + messageID,
    sessionID: S,
    messageID,
    type: 'text',
    text: t,
    time: { start: 1, end: 2 },
  },
});
const tool = (messageID: string) => ({
  type: 'tool_use',
  timestamp: 2,
  sessionID: S,
  part: {
    partID: 'x',
    sessionID: S,
    messageID,
    type: 'tool',
    id: 'call',
    tool: 'write',
    state: { status: 'completed' },
  },
});

describe('OpenCode tool runs', () => {
  it('follows steps to the final message and sums tokens', () => {
    const s = new OpenCodeRunStream(S);
    const out = s.receive(
      Buffer.concat([
        line(step('m1')),
        line(tool('m1')),
        line(finish('m1')),
        line(step('m2')),
        line(text('m2', 'done')),
      ]),
    );
    expect(out.signals).toEqual([
      { kind: 'activity', text: 'write:completed' },
      { kind: 'text', text: 'done' },
    ]);
    expect(s.end()).toEqual({
      kind: 'completed',
      nativeMessageId: 'm2',
      text: 'done',
      tokens: 15,
    });
  });
  it('stops on any billed step', () => {
    const s = new OpenCodeRunStream(S);
    expect(() =>
      s.receive(Buffer.concat([line(step('m1')), line(finish('m1', 0.01))])),
    ).toThrow('BILLING_UNVERIFIED');
  });
  it('rejects events from another session or message', () => {
    expect(() =>
      new OpenCodeRunStream(S).receive(
        line({ ...step('m1'), sessionID: 'ses_other' }),
      ),
    ).toThrow();
    const s = new OpenCodeRunStream(S);
    expect(() =>
      s.receive(Buffer.concat([line(step('m1')), line(text('m9', 'x'))])),
    ).toThrow('INVALID_EVENT');
  });
  it('classifies provider errors and treats an empty run as unknown', () => {
    const s = new OpenCodeRunStream(S);
    s.receive(
      Buffer.concat([
        line(step('m1')),
        line({
          type: 'error',
          timestamp: 1,
          sessionID: S,
          error: { type: 'x', status: 429 },
        }),
      ]),
    );
    expect(s.end()).toMatchObject({
      kind: 'failed',
      failure: { code: 'QUOTA_BLOCKED' },
    });
    expect(() => new OpenCodeRunStream(S).end()).toThrow('OPERATION_UNKNOWN');
  });
});

const U = '6306ed11-5ca4-4c61-a177-5b64eddf5d5b';
const init = (over: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'init',
  session_id: U,
  apiKeySource: 'none',
  claude_code_version: '2.1.285',
  permissionMode: 'acceptEdits',
  model: 'm',
  ...over,
});
const result = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: U,
  uuid: 'r1',
  result: 'ok',
  usage: { input_tokens: 3, output_tokens: 4 },
  total_cost_usd: 0.1,
  ...over,
});
describe('Claude headless turns', () => {
  it('validates init and returns the single result', () => {
    const s = new ClaudeHeadlessStream(U, 'workspace-write');
    const out = s.receive(
      Buffer.concat([
        line(init()),
        line({ type: 'system', subtype: 'api_retry' }),
        line(result()),
      ]),
    );
    expect(out.signals.map((x) => x.kind)).toEqual(['init', 'retry']);
    expect(s.end()).toEqual({
      kind: 'completed',
      runId: 'r1',
      text: 'ok',
      tokens: 7,
      estimatedUsd: 0.1,
    });
  });
  it.each([
    ['an API key', { apiKeySource: 'ANTHROPIC_API_KEY' }, 'BILLING_UNVERIFIED'],
    [
      'another session',
      { session_id: '00000000-0000-4000-8000-000000000000' },
      'SESSION_MISMATCH',
    ],
    ['another version', { claude_code_version: '2.1.284' }, 'SESSION_MISMATCH'],
    [
      'a broader permission mode',
      { permissionMode: 'bypassPermissions' },
      'SESSION_MISMATCH',
    ],
  ])('refuses init with %s', (_n, over, code) =>
    expect(() =>
      new ClaudeHeadlessStream(U, 'workspace-write').receive(line(init(over))),
    ).toThrow(code),
  );
  it('rejects frames after the result and a missing result', () => {
    const s = new ClaudeHeadlessStream(U, 'text');
    expect(() =>
      s.receive(
        Buffer.concat([
          line(init({ permissionMode: 'default' })),
          line(result()),
          line(result()),
        ]),
      ),
    ).toThrow();
    const t = new ClaudeHeadlessStream(U, 'text');
    t.receive(line(init({ permissionMode: 'default' })));
    expect(() => t.end()).toThrow('OPERATION_UNKNOWN');
  });
  it('classifies an error result', () => {
    const s = new ClaudeHeadlessStream(U, 'workspace-write');
    s.receive(
      Buffer.concat([
        line(init()),
        line({
          type: 'assistant',
          error: 'rate_limit',
          message: { content: [] },
        }),
        line(result({ subtype: 'error_during_execution', is_error: true })),
      ]),
    );
    expect(s.end()).toMatchObject({
      kind: 'failed',
      failure: { code: 'QUOTA_BLOCKED' },
    });
  });
});
