import { z } from 'zod';
import { JsonLineDecoder } from '../codex/transport.ts';
import {
  nativeIdSchema,
  type NativeFailure,
} from '../../../contracts/src/providers.ts';

export const OPENCODE_CLI_VERSION = '2.0.19';
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base = { timestamp: time, sessionID: nativeIdSchema };
const partBase = {
  id: nativeIdSchema,
  sessionID: nativeIdSchema,
  messageID: nativeIdSchema,
};
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('step_start'),
    part: z.strictObject({
      ...partBase,
      type: z.literal('step-start'),
      snapshot: z.string().max(512).optional(),
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal('text'),
    part: z.strictObject({
      ...partBase,
      type: z.literal('text'),
      text: z.string().min(1).max(65536),
      time: z.strictObject({ start: time, end: time }),
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal('error'),
    error: z.strictObject({
      type: z.enum(['provider.auth', 'unknown']),
      message: z.string().max(16384),
      status: z.number().int().min(100).max(599).optional(),
    }),
  }),
]);
export type OpenCodeCliResult =
  | { kind: 'completed'; nativeMessageId: string; text: string }
  | {
      kind: 'failed';
      nativeMessageId?: string;
      text: string;
      failure: NativeFailure;
    };
function fail(code: string): never {
  throw new Error(code);
}

/** A single pinned CLI invocation. Host must establish clean process exit before accepting end(). */
export class OpenCodeCliStream {
  private readonly decoder = new JsonLineDecoder();
  private closed = false;
  private bytes = 0;
  private messages = 0;
  private nativeMessageId: string | undefined;
  private readonly partIds = new Set<string>();
  private text = '';
  private nativeFailure: NativeFailure | undefined;
  private readonly expectedSessionId: string;
  private readonly onMessage:
    ((message: Record<string, unknown>) => void) | undefined;
  constructor(
    expectedSessionId: string,
    onMessage?: (message: Record<string, unknown>) => void,
  ) {
    nativeIdSchema.parse(expectedSessionId);
    this.expectedSessionId = expectedSessionId;
    this.onMessage = onMessage;
  }
  get failure(): NativeFailure | undefined {
    return this.nativeFailure ? { ...this.nativeFailure } : undefined;
  }
  receive(chunk: Uint8Array): void {
    if (this.closed) fail('CONNECTION_CLOSED');
    try {
      this.bytes += chunk.byteLength;
      if (this.bytes > 1048576) fail('LIMIT_EXCEEDED');
      // Process one line at a time so a valid error is retained if a later line is malformed.
      const buffer = Buffer.from(chunk);
      const pieces: Buffer[] = [];
      let offset = 0;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] === 10) {
          pieces.push(buffer.subarray(offset, index + 1));
          offset = index + 1;
        }
      }
      if (offset < buffer.length) pieces.push(buffer.subarray(offset));
      for (const piece of pieces)
        for (const frame of this.decoder.push(piece)) {
          if (++this.messages > 4096) fail('LIMIT_EXCEEDED');
          const parsed = eventSchema.safeParse(frame);
          if (!parsed.success || this.nativeFailure) fail('INVALID_EVENT');
          const event = parsed.data;
          if (event.sessionID !== this.expectedSessionId) fail('INVALID_EVENT');
          if (event.type !== 'error') {
            const part = event.part;
            if (
              part.sessionID !== this.expectedSessionId ||
              this.partIds.has(part.id)
            )
              fail('INVALID_EVENT');
            if (event.type === 'step_start') {
              if (this.nativeMessageId !== undefined) fail('INVALID_EVENT');
            } else if (
              this.nativeMessageId !== part.messageID ||
              event.part.time.end < event.part.time.start
            )
              fail('INVALID_EVENT');
          }
          // Only fully validated frames cross the synchronous host persistence barrier.
          const barrier: unknown = this.onMessage?.(structuredClone(event));
          if (barrier !== undefined) {
            void Promise.resolve(barrier).catch(() => {});
            fail('INVALID_PERSISTENCE_BARRIER');
          }
          if (event.type === 'error') {
            this.nativeFailure =
              event.error.type === 'provider.auth'
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
                  : {
                      code: 'WORKER_FAILED',
                      scope: 'attempt',
                      native: 'unknown',
                    };
            this.text = '';
          } else {
            this.partIds.add(event.part.id);
            if (event.type === 'step_start')
              this.nativeMessageId = event.part.messageID;
            else this.text += event.part.text;
          }
        }
    } catch (error) {
      this.closed = true;
      this.text = '';
      throw error;
    }
  }
  end(): OpenCodeCliResult {
    if (this.closed) fail('OPERATION_UNKNOWN');
    this.closed = true;
    try {
      this.decoder.end();
      if (this.nativeFailure)
        return {
          kind: 'failed',
          ...(this.nativeMessageId === undefined
            ? {}
            : { nativeMessageId: this.nativeMessageId }),
          text: '',
          failure: { ...this.nativeFailure },
        };
      if (this.nativeMessageId === undefined || !this.text.trim())
        fail('OPERATION_UNKNOWN');
      return {
        kind: 'completed',
        nativeMessageId: this.nativeMessageId,
        text: this.text,
      };
    } finally {
      this.text = '';
    }
  }
}
