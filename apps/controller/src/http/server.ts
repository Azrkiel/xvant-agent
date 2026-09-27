import { ZodError } from 'zod';
import { DomainError } from '../../../../packages/contracts/src/index.ts';
import { StorageError } from '../../../../packages/storage/src/store.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type ApiCommand =
  | { kind: 'create'; commandId: string; input: Record<string, unknown> }
  | {
      kind: 'dispatch' | 'queue' | 'accept';
      commandId: string;
      taskId: string;
      input: Record<string, unknown>;
    };
export interface ApiOptions {
  command: (command: ApiCommand) => Promise<unknown>;
  events: (after: number) => Promise<unknown>;
  port?: number;
  maxBodyBytes?: number;
}
class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
function publicError(error: unknown): { status: number; code: string } {
  if (error instanceof RequestError) return error;
  if (error instanceof ZodError) return { status: 400, code: 'INVALID_INPUT' };
  if (error instanceof DomainError || error instanceof StorageError) {
    const code = error.code;
    if (code === 'NOT_FOUND') return { status: 404, code };
    if (
      [
        'INVALID_INPUT',
        'INVALID_EVENT',
        'INVALID_EVIDENCE',
        'GRAPH_INVALID',
        'LIMIT_EXCEEDED',
      ].includes(code)
    )
      return { status: 400, code };
    if (
      [
        'CONFLICT',
        'DUPLICATE_IDENTITY',
        'LEASE_BUSY',
        'STALE_FENCE',
        'UNRESOLVED_OPERATION',
        'ILLEGAL_TRANSITION',
        'EVIDENCE_REQUIRED',
        'STALE_EVIDENCE',
        'CHECK_FAILED',
        'WORKER_BUSY',
        'VERIFICATION_FAILED',
      ].includes(code)
    )
      return { status: 409, code };
  }
  return { status: 500, code: 'INTERNAL_ERROR' };
}
const token = () => randomBytes(32).toString('hex');
function equal(actual: string | undefined, expected: string): boolean {
  const value = Buffer.from(actual ?? '');
  const target = Buffer.from(expected);
  return value.length === target.length && timingSafeEqual(value, target);
}
function reply(res: ServerResponse, status: number, data: unknown): void {
  // Serialize before writing headers so serialization failures remain redacted.
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}
async function body(
  req: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE');
  if (Number(req.headers['content-length'] ?? 0) > limit)
    throw new RequestError(413, 'BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  // Data listeners let us return 413 without destroying the response socket.
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RequestError(413, 'BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
    req.on('aborted', () => reject(new RequestError(400, 'INVALID_BODY')));
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'INVALID_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new RequestError(400, 'INVALID_BODY');
  return parsed as Record<string, unknown>;
}

/** The capability is delivered out of band by the launcher, never in a URL. */
export async function startLoopbackApi(options: ApiOptions): Promise<{
  origin: string;
  bootstrapToken: string;
  close: () => Promise<void>;
}> {
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > 1024 * 1024
  )
    throw new Error('Invalid body limit');
  const bootstrapToken = token();
  const session = token();
  const csrfToken = token();
  let bootstrapUsed = false;
  let origin = '';
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.headers.host !== origin.slice('http://'.length))
        throw new RequestError(403, 'INVALID_HOST');
      const mutation = req.method !== 'GET';
      if (
        (mutation || req.headers.origin !== undefined) &&
        req.headers.origin !== origin
      )
        throw new RequestError(403, 'INVALID_ORIGIN');
      if (!req.url?.startsWith('/') || req.url.startsWith('//'))
        throw new RequestError(404, 'NOT_FOUND');
      if (req.method === 'POST' && req.url === '/api/v1/session') {
        if (
          bootstrapUsed ||
          !equal(req.headers.authorization, `Bearer ${bootstrapToken}`)
        )
          throw new RequestError(401, 'UNAUTHORIZED');
        bootstrapUsed = true;
        res.setHeader(
          'set-cookie',
          `xvant_session=${session}; HttpOnly; SameSite=Strict; Path=/api/v1`,
        );
        reply(res, 200, { csrfToken });
        return;
      }
      const cookies = (req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith('xvant_session='));
      if (
        !bootstrapUsed ||
        cookies.length !== 1 ||
        !equal(cookies[0]?.slice('xvant_session='.length), session)
      )
        throw new RequestError(401, 'UNAUTHORIZED');
      if (
        mutation &&
        !equal(
          typeof req.headers['x-csrf-token'] === 'string'
            ? req.headers['x-csrf-token']
            : undefined,
          csrfToken,
        )
      )
        throw new RequestError(403, 'INVALID_CSRF');
      if (
        req.method === 'GET' &&
        /^\/api\/v1\/events(?:\?after=[0-9]+)?$/.test(req.url)
      ) {
        const after = Number(
          new URL(req.url, origin).searchParams.get('after') ?? 0,
        );
        if (!Number.isSafeInteger(after))
          throw new RequestError(400, 'INVALID_CURSOR');
        reply(res, 200, await options.events(after));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/v1/events?'))
        throw new RequestError(400, 'INVALID_CURSOR');
      const dispatch =
        /^\/api\/v1\/tasks\/([A-Za-z][A-Za-z0-9_-]{0,63})\/(dispatch|queue|accept)$/.exec(
          req.url,
        );
      if (req.method !== 'POST' || (req.url !== '/api/v1/tasks' && !dispatch))
        throw new RequestError(404, 'NOT_FOUND');
      const commandId = req.headers['idempotency-key'];
      if (
        typeof commandId !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(commandId)
      )
        throw new RequestError(400, 'INVALID_COMMAND_ID');
      const input = await body(req, maxBodyBytes);
      const command: ApiCommand = dispatch
        ? {
            kind: dispatch[2] as 'dispatch' | 'queue' | 'accept',
            commandId,
            taskId: dispatch[1]!,
            input,
          }
        : { kind: 'create', commandId, input };
      reply(res, 202, await options.command(command));
    } catch (error) {
      if (!res.headersSent)
        reply(res, publicError(error).status, {
          error: publicError(error).code,
        });
      else res.end();
    }
  };
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 },
    (req, res) => {
      void handle(req, res);
    },
  );
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Invalid loopback address');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    bootstrapToken,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
