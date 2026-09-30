import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export interface Route {
  method: 'GET' | 'POST';
  /** Anchored pattern for the path (no query string). */
  path: RegExp;
  handle: (context: {
    match: RegExpExecArray;
    query: URLSearchParams;
    body: Record<string, unknown>;
  }) => Promise<unknown>;
}
export interface Stream {
  /** Replays events after the cursor, then pushes new ones until closed. */
  subscribe: (
    after: number,
    push: (event: { id: number; data: unknown }) => void,
  ) => () => void;
}
export interface Asset {
  type: string;
  body: Buffer;
}
const token = () => randomBytes(32).toString('hex');
function equal(actual: string | undefined, expected: string): boolean {
  const value = Buffer.from(actual ?? '');
  const target = Buffer.from(expected);
  return value.length === target.length && timingSafeEqual(value, target);
}
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
function send(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}
async function readJson(
  req: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE');
  if (Number(req.headers['content-length'] ?? 0) > limit)
    throw new HttpError(413, 'BODY_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) reject(new HttpError(413, 'BODY_TOO_LARGE'));
      else chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new HttpError(400, 'INVALID_BODY');
  return parsed as Record<string, unknown>;
}

/**
 * XVANT's local application server. Loopback only. The launcher opens the
 * browser with a single-use bootstrap token in the URL fragment (never sent
 * to the server); the page exchanges it once for an HttpOnly, SameSite=Strict
 * session cookie and a CSRF token. Every API call needs the cookie; every
 * mutation also needs the CSRF header and this exact Origin. Static assets
 * carry no data and are public. Host headers must name this listener, which
 * defeats DNS rebinding.
 */
export async function startAppServer(options: {
  routes: Route[];
  stream: Stream;
  assets: Record<string, Asset>;
  port?: number;
  maxBodyBytes?: number;
  toError?: (error: unknown) => { status: number; code: string } | undefined;
}): Promise<{
  origin: string;
  bootstrapToken: string;
  /** For the cookie-authenticated CSRF refresh route after a reload. */
  csrfToken: () => string;
  close: () => Promise<void>;
}> {
  const limit = options.maxBodyBytes ?? 256 * 1024;
  const bootstrapToken = token();
  const session = token();
  const csrfToken = token();
  let bootstrapUsed = false;
  let origin = '';
  const streams = new Set<() => void>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.headers.host !== origin.slice('http://'.length))
        throw new HttpError(403, 'INVALID_HOST');
      const url = new URL(req.url ?? '/', origin);
      if (!req.url?.startsWith('/') || req.url.startsWith('//'))
        throw new HttpError(404, 'NOT_FOUND');
      const mutation = req.method !== 'GET' && req.method !== 'HEAD';
      if (
        (mutation || req.headers.origin !== undefined) &&
        req.headers.origin !== origin
      )
        throw new HttpError(403, 'INVALID_ORIGIN');
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const asset =
          options.assets[url.pathname === '/' ? '/index.html' : url.pathname];
        if (!asset) throw new HttpError(404, 'NOT_FOUND');
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': asset.type,
          'cache-control': 'no-cache',
          'content-security-policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        });
        res.end(asset.body);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/session') {
        if (
          bootstrapUsed ||
          !equal(req.headers.authorization, 'Bearer ' + bootstrapToken)
        )
          throw new HttpError(401, 'UNAUTHORIZED');
        bootstrapUsed = true;
        res.setHeader(
          'set-cookie',
          `xvant_session=${session}; HttpOnly; SameSite=Strict; Path=/api/v1`,
        );
        send(res, 200, { csrfToken });
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
        throw new HttpError(401, 'UNAUTHORIZED');
      if (
        mutation &&
        !equal(
          typeof req.headers['x-csrf-token'] === 'string'
            ? req.headers['x-csrf-token']
            : undefined,
          csrfToken,
        )
      )
        throw new HttpError(403, 'INVALID_CSRF');
      if (req.method === 'GET' && url.pathname === '/api/v1/stream') {
        const header = req.headers['last-event-id'];
        const after = Number(
          (typeof header === 'string' ? header : undefined) ??
            url.searchParams.get('after') ??
            0,
        );
        if (!Number.isSafeInteger(after) || after < 0)
          throw new HttpError(400, 'INVALID_CURSOR');
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        // Backpressure: a client that stops reading is dropped, then reconnects from its cursor.
        let stop = () => {};
        const push = (event: { id: number; data: unknown }) => {
          const ok = res.write(
            'id: ' +
              event.id +
              '\ndata: ' +
              JSON.stringify(event.data) +
              '\n\n',
          );
          if (!ok && res.writableLength > 1024 * 1024) close();
        };
        const keepAlive = setInterval(
          () => res.write(': keep-alive\n\n'),
          15000,
        );
        const close = () => {
          clearInterval(keepAlive);
          stop();
          streams.delete(close);
          res.end();
        };
        streams.add(close);
        stop = options.stream.subscribe(after, push);
        req.on('close', close);
        return;
      }
      for (const route of options.routes) {
        if (route.method !== req.method) continue;
        const match = route.path.exec(url.pathname);
        if (!match) continue;
        const body = req.method === 'POST' ? await readJson(req, limit) : {};
        send(
          res,
          req.method === 'POST' ? 202 : 200,
          await route.handle({ match, query: url.searchParams, body }),
        );
        return;
      }
      throw new HttpError(404, 'NOT_FOUND');
    } catch (error) {
      const mapped =
        error instanceof HttpError
          ? error
          : (options.toError?.(error) ?? {
              status: 500,
              code: 'INTERNAL_ERROR',
            });
      if (!res.headersSent) send(res, mapped.status, { error: mapped.code });
      else res.end();
    }
  };
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 },
    (req, res) => void handle(req, res),
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
  origin = 'http://127.0.0.1:' + address.port;
  return {
    origin,
    bootstrapToken,
    csrfToken: () => csrfToken,
    close: () =>
      new Promise<void>((resolve) => {
        for (const close of [...streams]) close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
