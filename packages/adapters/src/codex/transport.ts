import { z } from 'zod';

function fail(code: string): never {
  throw new Error(code);
}
export class JsonLineDecoder {
  private buffer = Buffer.alloc(0);
  private poisoned = false;
  private readonly limit: number;
  constructor(maxFrameBytes = 65536) {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes < 1 ||
      maxFrameBytes > 1048576
    )
      fail('INVALID_INPUT');
    this.limit = maxFrameBytes;
  }
  push(chunk: Uint8Array): Record<string, unknown>[] {
    if (this.poisoned) fail('CONNECTION_CLOSED');
    try {
      if (chunk.byteLength > 1048576) fail('LIMIT_EXCEEDED');
      const bytes = Buffer.concat([this.buffer, chunk]);
      const frames: Record<string, unknown>[] = [];
      let offset = 0;
      for (;;) {
        const end = bytes.indexOf(10, offset);
        if (end < 0) break;
        if (end - offset > this.limit || frames.length >= 1024)
          fail('LIMIT_EXCEEDED');
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              bytes.subarray(offset, end),
            ),
          );
        } catch {
          fail('INVALID_EVENT');
        }
        if (!value || typeof value !== 'object' || Array.isArray(value))
          fail('INVALID_EVENT');
        frames.push(value as Record<string, unknown>);
        offset = end + 1;
      }
      if (bytes.length - offset > this.limit) fail('LIMIT_EXCEEDED');
      this.buffer = Buffer.from(bytes.subarray(offset));
      return frames;
    } catch (error) {
      this.poisoned = true;
      this.buffer = Buffer.alloc(0);
      throw error;
    }
  }
  end(): void {
    if (this.poisoned) fail('CONNECTION_CLOSED');
    this.poisoned = true;
    if (this.buffer.length) {
      this.buffer = Buffer.alloc(0);
      fail('OPERATION_UNKNOWN');
    }
  }
}

const rpcId = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().min(1).max(128),
]);
const messageSchema = z.union([
  z
    .strictObject({ id: rpcId, result: z.unknown() })
    .refine((v) => Object.hasOwn(v, 'result')),
  z.strictObject({
    id: rpcId,
    error: z.object({
      code: z
        .number()
        .int()
        .min(Number.MIN_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
      message: z.string().max(16384),
      data: z.unknown().optional(),
    }),
  }),
  z.strictObject({
    id: rpcId.optional(),
    method: z.string().min(1).max(128),
    params: z.unknown().optional(),
  }),
]);
export interface WriteIntent {
  id: number;
  method: string;
  params: unknown;
  frame: string;
}
export interface ChannelOptions {
  /** Host must persist this exact intent before resolving. A rejection prevents the write. */
  beforeWrite: (intent: WriteIntent) => Promise<void>;
  /** Synchronous durable barrier: commit before any callback or request resolution. */
  beforeReceive?: (message: Record<string, unknown>) => void;
  onClose?: () => void;
  write: (frame: string) => Promise<void>;
  onMessage?: (message: {
    id?: string | number | undefined;
    method: string;
    params?: unknown;
  }) => void;
  timeoutMs?: number;
  maxPending?: number;
  maxFrameBytes?: number;
}
interface Pending {
  attempted: boolean;
  expectsReply: boolean;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
class ReceiveStorageError extends Error {}

/** Bounded host-driven channel. No process launch, credentials, or retry policy. */
export class RpcChannel {
  private readonly options: ChannelOptions;
  private readonly decoder: JsonLineDecoder;
  private readonly pending = new Map<number, Pending>();
  private readonly uncertain = new Set<number>();
  private nextId = 1;
  private closed = false;
  private inputEnded = false;
  constructor(options: ChannelOptions) {
    this.options = { ...options };
    this.decoder = new JsonLineDecoder(options.maxFrameBytes);
    if (
      !Number.isSafeInteger(options.maxPending ?? 16) ||
      (options.maxPending ?? 16) < 1 ||
      (options.maxPending ?? 16) > 64 ||
      !Number.isSafeInteger(options.timeoutMs ?? 10000) ||
      (options.timeoutMs ?? 10000) < 1 ||
      (options.timeoutMs ?? 10000) > 60000
    )
      fail('INVALID_INPUT');
  }
  get uncertainIds(): number[] {
    return [...this.uncertain];
  }
  private poison(code: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      if (pending.attempted) this.uncertain.add(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(code));
    }
    this.pending.clear();
    try {
      this.options.onClose?.();
    } catch {
      // A failed store is recovered under a new fence; never mask the channel failure.
    }
  }
  async request(method: string, params: unknown): Promise<unknown> {
    return this.send(method, params, 'request');
  }
  async notify(method: string, params: unknown): Promise<void> {
    await this.send(method, params, 'notification');
  }
  async respond(id: string | number, result: unknown): Promise<void> {
    rpcId.parse(id);
    await this.send('response', { id, result }, 'response');
  }
  private async send(
    method: string,
    params: unknown,
    kind: 'request' | 'notification' | 'response',
  ): Promise<unknown> {
    if (this.closed || this.inputEnded) fail('CONNECTION_CLOSED');
    if (this.pending.size >= (this.options.maxPending ?? 16))
      fail('WORKER_BUSY');
    if (
      !/^[A-Za-z][A-Za-z0-9/._-]{0,127}$/.test(method) ||
      this.nextId > Number.MAX_SAFE_INTEGER
    )
      fail('INVALID_INPUT');
    const id = this.nextId++;
    let frame: string;
    try {
      frame =
        JSON.stringify(
          kind === 'request'
            ? { id, method, params }
            : kind === 'notification'
              ? { method, params }
              : params,
        ) + '\n';
    } catch {
      fail('INVALID_INPUT');
    }
    if (Buffer.byteLength(frame) > (this.options.maxFrameBytes ?? 65536))
      fail('LIMIT_EXCEEDED');
    const intent: WriteIntent = {
      id,
      method,
      params: structuredClone(params),
      frame,
    };
    return new Promise((resolve, reject) => {
      const entry: Pending = {
        attempted: false,
        expectsReply: kind === 'request',
        resolve,
        reject,
        timer: setTimeout(
          () => this.poison('OPERATION_UNKNOWN'),
          this.options.timeoutMs ?? 10000,
        ),
      };
      this.pending.set(id, entry);
      void (async () => {
        try {
          await this.options.beforeWrite(intent);
        } catch {
          this.poison('STORAGE_UNAVAILABLE');
          return;
        }
        if (this.closed || !this.pending.has(id)) return;
        entry.attempted = true;
        try {
          await this.options.write(frame);
          if (!entry.expectsReply && this.pending.has(id)) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.resolve(undefined);
          }
        } catch {
          this.poison('OPERATION_UNKNOWN');
        }
      })();
    });
  }
  receive(chunk: Uint8Array): void {
    if (this.closed || this.inputEnded) fail('CONNECTION_CLOSED');
    try {
      for (const frame of this.decoder.push(chunk)) {
        const message = messageSchema.parse(frame);
        if ('method' in message) {
          this.persistReceived(message);
          this.options.onMessage?.(message);
          continue;
        }
        const entry =
          typeof message.id === 'number'
            ? this.pending.get(message.id)
            : undefined;
        if (!entry || !entry.attempted || !entry.expectsReply)
          fail('INVALID_EVENT');
        this.persistReceived(message);
        clearTimeout(entry.timer);
        this.pending.delete(message.id as number);
        if ('error' in message)
          entry.reject(new Error('RPC_ERROR:' + message.error.code));
        else entry.resolve(message.result);
      }
    } catch (error) {
      const code =
        error instanceof ReceiveStorageError
          ? 'STORAGE_UNAVAILABLE'
          : 'INVALID_EVENT';
      this.poison(code);
      fail(code);
    }
  }
  private persistReceived(message: Record<string, unknown>): void {
    try {
      const result: unknown = this.options.beforeReceive?.(message);
      if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => {});
        throw new ReceiveStorageError();
      }
    } catch {
      throw new ReceiveStorageError();
    }
  }
  /** Validate EOF before the host commits a terminal outcome. */
  endReceive(): void {
    if (this.closed) fail('CONNECTION_CLOSED');
    if (this.inputEnded) return;
    try {
      this.decoder.end();
      if (this.pending.size) fail('OPERATION_UNKNOWN');
      this.inputEnded = true;
    } catch (error) {
      this.poison('OPERATION_UNKNOWN');
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    // Even clean EOF is an unknown outcome for every unacknowledged request.
    try {
      if (!this.inputEnded) this.decoder.end();
    } finally {
      this.poison('OPERATION_UNKNOWN');
    }
  }
}
