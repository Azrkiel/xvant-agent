import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { versions } from '../providers/native-profiles.ts';

/** Username the OpenCode server expects when OPENCODE_SERVER_PASSWORD is set. */
export const OPENCODE_USERNAME = 'opencode';
const MAX_BODY = 65536;
function fail(code: string): never {
  throw new Error(code);
}
/** Host-generated per-launch secret. Never persisted, logged or journaled. */
export function createEndpointSecret(): string {
  return randomBytes(32).toString('base64url');
}
export function secretDigest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
/**
 * Parse the pinned SDK's startup line (`opencode server listening on <url>`).
 * Only a numeric loopback origin with an explicit port is accepted.
 */
export function parseAnnouncement(line: string): string {
  const match =
    /^opencode server listening on (http:\/\/127\.0\.0\.1:(\d{1,5}))\/?$/.exec(
      line.trim(),
    );
  const port = Number(match?.[2]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535)
    fail('ENDPOINT_REJECTED');
  return match[1]!;
}
export interface HttpReply {
  status: number;
  body: unknown;
}
/**
 * Authenticated client for one owned loopback OpenCode server. No redirects,
 * keep-alive, proxies or credential reuse across endpoints.
 */
export class OpenCodeEndpoint {
  readonly origin: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly streams = new Set<IncomingMessage>();
  constructor(origin: string, secret: string, timeoutMs = 5000) {
    this.origin = parseAnnouncement('opencode server listening on ' + origin);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) fail('INVALID_INPUT');
    this.authorization =
      'Basic ' +
      Buffer.from(OPENCODE_USERNAME + ':' + secret).toString('base64');
    this.timeoutMs = timeoutMs;
  }
  private open(
    method: 'GET' | 'POST',
    path: string,
    options: { authenticated?: boolean; body?: unknown; accept?: string } = {},
  ): Promise<IncomingMessage> {
    if (!path.startsWith('/') || path.startsWith('//')) fail('INVALID_INPUT');
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) fail('INVALID_INPUT');
    const payload =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    if (payload && Buffer.byteLength(payload) > MAX_BODY)
      fail('LIMIT_EXCEEDED');
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        url,
        {
          method,
          agent: false,
          timeout: this.timeoutMs,
          headers: {
            accept: options.accept ?? 'application/json',
            ...(options.authenticated === false
              ? {}
              : { authorization: this.authorization }),
            ...(payload
              ? {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        resolve,
      );
      outgoing.on('timeout', () => outgoing.destroy(new Error('TIMEOUT')));
      outgoing.on('error', () => reject(new Error('ENDPOINT_UNAVAILABLE')));
      outgoing.end(payload);
    });
  }
  /** Bounded JSON request. 204 yields `undefined`; redirects are refused. */
  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    authenticated = true,
  ): Promise<HttpReply> {
    const response = await this.open(method, path, { body, authenticated });
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          response.destroy();
          reject(new Error('LIMIT_EXCEEDED'));
        } else chunks.push(chunk);
      });
      response.on('end', resolve);
      response.on('error', () => reject(new Error('ENDPOINT_UNAVAILABLE')));
    });
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) fail('ENDPOINT_REJECTED');
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return { status, body: undefined };
    if (!/^application\/json\b/.test(response.headers['content-type'] ?? ''))
      return { status, body: undefined };
    try {
      return { status, body: JSON.parse(text) as unknown };
    } catch {
      fail('INVALID_EVENT');
    }
  }
  /**
   * Prove ownership before any session traffic: the server must refuse an
   * unauthenticated request and report the pinned version when authenticated.
   * A server started without OPENCODE_SERVER_PASSWORD fails closed here.
   */
  async verify(): Promise<{ version: string }> {
    const anonymous = await this.request(
      'GET',
      '/global/health',
      undefined,
      false,
    );
    if (anonymous.status !== 401) fail('ENDPOINT_UNAUTHENTICATED');
    const health = await this.request('GET', '/global/health');
    const parsed = z
      .object({ healthy: z.literal(true), version: z.string() })
      .safeParse(health.body);
    if (health.status !== 200 || !parsed.success) fail('ENDPOINT_REJECTED');
    if (parsed.data.version !== versions.opencode) fail('VERSION_UNSUPPORTED');
    return { version: parsed.data.version };
  }
  /** Authenticated SSE subscription; chunks go to the caller's bounded decoder. */
  async events(
    directory: string,
    onChunk: (chunk: Buffer) => void,
    onEnd: (clean: boolean) => void,
  ): Promise<void> {
    const response = await this.open(
      'GET',
      '/event?directory=' + encodeURIComponent(directory),
      { accept: 'text/event-stream' },
    );
    if (
      response.statusCode !== 200 ||
      !/^text\/event-stream\b/.test(response.headers['content-type'] ?? '')
    ) {
      response.destroy();
      fail('ENDPOINT_REJECTED');
    }
    // Quiet turns are normal; the owned process deadline bounds the stream.
    response.socket.setTimeout(0);
    this.streams.add(response);
    let ended = false;
    const end = (clean: boolean) => {
      if (ended) return;
      ended = true;
      this.streams.delete(response);
      onEnd(clean);
    };
    response.on('data', onChunk);
    response.on('end', () => end(true));
    response.on('error', () => end(false));
    response.on('close', () => end(false));
  }
  close(): void {
    for (const stream of this.streams) stream.destroy();
    this.streams.clear();
  }
}
