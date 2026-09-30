import { z } from 'zod';
import { JsonLineDecoder } from '../codex/transport.ts';
import {
  nativeIdSchema,
  type NativeFailure,
} from '../../../contracts/src/providers.ts';

const time = z.number().int().nonnegative();
const part = {
  sessionID: nativeIdSchema,
  messageID: nativeIdSchema,
};
// Loose objects: 2.0.19 adds fields over time; identity fields are strict.
const eventSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('step_start'),
    sessionID: nativeIdSchema,
    part: z.looseObject({ ...part, type: z.literal('step-start') }),
  }),
  z.looseObject({
    type: z.literal('tool_use'),
    sessionID: nativeIdSchema,
    part: z.looseObject({
      ...part,
      type: z.literal('tool'),
      tool: z.string().max(128),
      state: z.looseObject({ status: z.string().max(32) }),
    }),
  }),
  z.looseObject({
    type: z.literal('step_finish'),
    sessionID: nativeIdSchema,
    part: z.looseObject({
      ...part,
      type: z.literal('step-finish'),
      reason: z.string().max(64).optional(),
      cost: z.number().nonnegative(),
      tokens: z
        .looseObject({ input: time, output: time, reasoning: time.optional() })
        .optional(),
    }),
  }),
  z.looseObject({
    type: z.literal('text'),
    sessionID: nativeIdSchema,
    part: z.looseObject({
      ...part,
      type: z.literal('text'),
      text: z.string().max(65536),
    }),
  }),
  z.looseObject({
    type: z.literal('error'),
    sessionID: nativeIdSchema,
    error: z.looseObject({
      type: z.string().max(64),
      status: z.number().int().min(100).max(599).optional(),
    }),
  }),
]);
export interface OpenCodeRunResult {
  kind: 'completed' | 'failed';
  nativeMessageId: string;
  text: string;
  tokens: number;
  failure?: NativeFailure;
}
export type OpenCodeSignal =
  { kind: 'text'; text: string } | { kind: 'activity'; text: string };

/**
 * One `opencode run --format json` invocation with tools. Every event must
 * belong to the expected session; steps may repeat and each gets its own
 * message. Any step reporting a nonzero cost stops the run: the approved
 * models are free, so a cost means a billed route was reached.
 */
export class OpenCodeRunStream {
  private readonly decoder = new JsonLineDecoder(1048576);
  private readonly session: string;
  private message: string | undefined;
  private lastText = '';
  private tokens = 0;
  private failure: NativeFailure | undefined;
  constructor(sessionId: string) {
    this.session = nativeIdSchema.parse(sessionId);
  }
  get failed(): NativeFailure | undefined {
    return this.failure;
  }
  receive(bytes: Uint8Array): {
    frames: Record<string, unknown>[];
    signals: OpenCodeSignal[];
  } {
    const frames = this.decoder.push(bytes);
    const signals: OpenCodeSignal[] = [];
    for (const frame of frames) {
      const event = eventSchema.parse(frame);
      if (event.sessionID !== this.session || this.failure)
        throw new Error('INVALID_EVENT');
      if (event.type === 'error') {
        this.failure =
          event.error.type === 'provider.auth' ||
          event.error.status === 401 ||
          event.error.status === 403
            ? {
                code: 'AUTH_REQUIRED',
                scope: 'quota_group',
                native: 'provider.auth',
              }
            : event.error.status === 429
              ? {
                  code: 'QUOTA_BLOCKED',
                  scope: 'quota_group',
                  native: 'http:429',
                }
              : { code: 'WORKER_FAILED', scope: 'attempt', native: 'unknown' };
        continue;
      }
      if (event.part.sessionID !== this.session)
        throw new Error('INVALID_EVENT');
      if (event.type === 'step_start') {
        this.message = event.part.messageID;
        this.lastText = '';
        continue;
      }
      if (event.part.messageID !== this.message)
        throw new Error('INVALID_EVENT');
      if (event.type === 'step_finish') {
        if (event.part.cost !== 0) throw new Error('BILLING_UNVERIFIED');
        this.tokens +=
          (event.part.tokens?.input ?? 0) + (event.part.tokens?.output ?? 0);
      } else if (event.type === 'tool_use')
        signals.push({
          kind: 'activity',
          text: event.part.tool + ':' + event.part.state.status,
        });
      else {
        this.lastText += event.part.text;
        signals.push({ kind: 'text', text: event.part.text.slice(0, 16384) });
      }
    }
    return { frames, signals };
  }
  end(): OpenCodeRunResult {
    this.decoder.end();
    if (!this.message) throw new Error('OPERATION_UNKNOWN');
    if (this.failure)
      return {
        kind: 'failed',
        nativeMessageId: this.message,
        text: '',
        tokens: this.tokens,
        failure: this.failure,
      };
    return {
      kind: 'completed',
      nativeMessageId: this.message,
      text: this.lastText,
      tokens: this.tokens,
    };
  }
}
