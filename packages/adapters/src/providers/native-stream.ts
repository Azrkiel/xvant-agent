import { JsonLineDecoder } from '../codex/transport.ts';
import { nativeIdSchema } from '../../../contracts/src/providers.ts';
import {
  versions,
  claudeSchema,
  opencodeSchema,
  type StreamKind,
} from './native-profiles.ts';

function fail(code: string): never {
  throw new Error(code);
}
/** Bounded LF/CRLF SSE data frames. No EventSource, HTTP client or reconnect. */
export class SseDecoder {
  private buffer = Buffer.alloc(0);
  private closed = false;
  push(chunk: Uint8Array): unknown[] {
    if (this.closed) fail('CONNECTION_CLOSED');
    try {
      if (chunk.byteLength > 1048576) fail('LIMIT_EXCEEDED');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const output: unknown[] = [];
      for (let count = 0; ; count++) {
        const text = this.buffer.toString('latin1');
        const boundary = /\r?\n\r?\n/.exec(text);
        if (!boundary) {
          if (this.buffer.length > 65536) fail('LIMIT_EXCEEDED');
          break;
        }
        if (boundary.index > 65536 || count >= 1024) fail('LIMIT_EXCEEDED');
        const frame = new TextDecoder('utf-8', { fatal: true }).decode(
          this.buffer.subarray(0, boundary.index),
        );
        this.buffer = this.buffer.subarray(boundary.index + boundary[0].length);
        const data: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value =
            colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'data') data.push(value);
          // id/retry never enable replay; other SSE fields carry no authority.
        }
        if (data.length) output.push(JSON.parse(data.join('\n')));
      }
      return output;
    } catch (error) {
      this.closed = true;
      this.buffer = Buffer.alloc(0);
      throw error;
    }
  }
  end(): void {
    if (this.closed) fail('CONNECTION_CLOSED');
    this.closed = true;
    if (this.buffer.length) fail('OPERATION_UNKNOWN');
  }
}
export interface StreamResult {
  kind: 'completed' | 'failed';
  sessionId: string;
  requestId: string;
  nativeMessageId: string;
}
export interface DenialAction {
  requestId: string;
  wire: unknown;
}
/** Host-owned, single-invocation offline projection. Results never grant acceptance. */
export class NativeStream {
  private readonly handleControl:
    ((message: Record<string, unknown>) => boolean) | undefined;
  private readonly kind: StreamKind;
  private session: string;
  private nativeMessages = 0;
  private sessionBound = false;
  private readonly request: string;
  private readonly decoder: JsonLineDecoder | SseDecoder;
  private readonly beforeReceive:
    ((message: Record<string, unknown>) => void) | undefined;
  private closed = false;
  private bytes = 0;
  private messages = 0;
  private readonly permissions = new Set<string>();
  private readonly pendingDenials = new Set<string>();
  private result: StreamResult | undefined;
  private state: 'running' | 'result_pending' | 'needs_attention' = 'running';
  constructor(
    kind: StreamKind,
    version: string,
    session: string,
    request: string,
    options: {
      beforeReceive?: (message: Record<string, unknown>) => void;
      handleControl?: (message: Record<string, unknown>) => boolean;
    } = {},
  ) {
    this.kind = kind;
    this.session = session;
    this.request = request;
    this.beforeReceive = options.beforeReceive;
    this.handleControl = options.handleControl;
    if (!Object.hasOwn(versions, kind) || versions[kind] !== version)
      fail('VERSION_UNSUPPORTED');
    nativeIdSchema.parse(session);
    nativeIdSchema.parse(request);
    this.decoder = kind === 'claude' ? new JsonLineDecoder() : new SseDecoder();
  }
  get status() {
    return this.state;
  }
  /** Host calls only after durable binding, before native invocation traffic. */
  bindSession(session: string): void {
    try {
      nativeIdSchema.parse(session);
      if (
        this.closed ||
        this.kind !== 'opencode' ||
        this.sessionBound ||
        this.nativeMessages ||
        !this.session.startsWith('pending:') ||
        session.startsWith('pending:')
      )
        fail('INVALID_EVENT');
      this.session = session;
      this.sessionBound = true;
    } catch (error) {
      this.cancel();
      throw error;
    }
  }
  receive(chunk: Uint8Array): DenialAction[] {
    if (this.closed) fail('CONNECTION_CLOSED');
    try {
      this.bytes += chunk.byteLength;
      if (this.bytes > 1048576) fail('LIMIT_EXCEEDED');
      const actions: DenialAction[] = [];
      for (const message of this.decoder.push(chunk)) {
        if (++this.messages > 4096) fail('LIMIT_EXCEEDED');
        if (!message || typeof message !== 'object' || Array.isArray(message))
          fail('INVALID_EVENT');
        // Persistence must complete synchronously before interpretation or denial delivery.
        const barrier: unknown = this.beforeReceive?.(
          message as Record<string, unknown>,
        );
        if (barrier !== undefined) {
          void Promise.resolve(barrier).catch(() => {});
          fail('INVALID_PERSISTENCE_BARRIER');
        }
        if (this.handleControl) {
          const handled: unknown = this.handleControl(
            message as Record<string, unknown>,
          );
          if (typeof handled !== 'boolean') {
            void Promise.resolve(handled).catch(() => {});
            fail('INVALID_PERSISTENCE_BARRIER');
          }
          if (handled) continue;
        }
        this.nativeMessages++;
        const action =
          this.kind === 'claude'
            ? this.claude(message)
            : this.opencode(message);
        if (action) actions.push(action);
      }
      return actions;
    } catch (error) {
      this.cancel();
      throw error;
    }
  }
  private permission(id: string) {
    if (this.result || this.permissions.has(id)) fail('INVALID_EVENT');
    if (this.permissions.size >= 64) fail('LIMIT_EXCEEDED');
    this.permissions.add(id);
    this.pendingDenials.add(id);
  }
  /** Trusted host calls only after its owned writer confirms the denial bytes. */
  denialWritten(id: string): void {
    if (this.closed) fail('CONNECTION_CLOSED');
    if (!this.pendingDenials.delete(id)) {
      this.cancel();
      fail('INVALID_EVENT');
    }
  }
  private finish(kind: StreamResult['kind'], nativeMessageId: string) {
    if (this.result) fail('INVALID_EVENT');
    this.result = {
      kind,
      nativeMessageId,
      sessionId: this.session,
      requestId: this.request,
    };
    this.state = 'result_pending';
  }
  private claude(input: unknown): DenialAction | undefined {
    const parsed = claudeSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_EVENT');
    const message = parsed.data;
    if (message.type === 'control_request') {
      this.permission(message.request_id);
      return {
        requestId: message.request_id,
        wire: {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: message.request_id,
            response: {
              behavior: 'deny',
              message: 'Offline host denies tool execution.',
            },
          },
        },
      };
    }
    if (message.session_id !== this.session) fail('INVALID_EVENT');
    if (message.type !== 'result') return;
    if (
      message.user_message_uuid !== this.request ||
      message.user_message_uuids?.some((id) => id !== this.request) ||
      message.resume_reason !== undefined ||
      (message.queued_turn_count ?? 0) !== 0 ||
      (message.result_index ?? 0) !== 0 ||
      message.deferred_tool_use !== undefined
    )
      fail('INVALID_EVENT');
    this.finish(
      message.subtype === 'success' &&
        !message.is_error &&
        ['end_turn', 'stop_sequence'].includes(message.stop_reason ?? '')
        ? 'completed'
        : 'failed',
      message.uuid,
    );
  }
  private opencode(input: unknown): DenialAction | undefined {
    const parsed = opencodeSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_EVENT');
    const message = parsed.data;
    if (message.properties.sessionID !== this.session) fail('INVALID_EVENT');
    if (message.type === 'session.error') fail('WORKER_FAILED');
    if (message.type === 'session.idle') return;
    if (message.type === 'permission.asked') {
      this.permission(message.properties.id);
      return {
        requestId: message.properties.id,
        wire: {
          method: 'POST',
          path:
            '/permission/' +
            encodeURIComponent(message.properties.id) +
            '/reply',
          body: { reply: 'reject' },
        },
      };
    }
    const info = message.properties.info;
    if (info.sessionID !== this.session || info.parentID !== this.request)
      fail('INVALID_EVENT');
    if (this.result) fail('INVALID_EVENT');
    if (info.error !== undefined) {
      this.finish('failed', info.id);
      return;
    }
    if (info.time.completed !== undefined) {
      if (info.time.completed < info.time.created) fail('INVALID_EVENT');
      if (info.finish === 'stop') this.finish('completed', info.id);
      else if (info.finish !== 'tool-calls') this.finish('failed', info.id);
    }
  }
  end(): StreamResult {
    if (this.closed) fail('OPERATION_UNKNOWN');
    try {
      this.decoder.end();
      if (!this.result || this.pendingDenials.size) fail('OPERATION_UNKNOWN');
      this.closed = true;
      return { ...this.result };
    } catch (error) {
      this.cancel();
      throw error;
    }
  }
  cancel(): void {
    this.closed = true;
    this.result = undefined;
    this.state = 'needs_attention';
  }
}
