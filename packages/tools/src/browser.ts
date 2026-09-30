import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DomainError, hashSchema } from '../../contracts/src/index.ts';
import { redactSecrets } from '../../context/src/secrets.ts';
import type { ArtifactStore } from '../../storage/src/artifacts.ts';
import type { Store } from '../../storage/src/store.ts';
import type { WorkerSupervisor } from '../../supervisor/src/index.ts';
import { defineTool } from './registry.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_SCREENSHOT = 8 * 1024 * 1024;

/** Minimal Chrome DevTools Protocol client over Node's WebSocket. */
class DevTools {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #listeners = new Map<string, ((params: never) => void)[]>();
  #next = 0;
  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: never;
        result?: unknown;
        error?: unknown;
      };
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) waiter?.reject(new Error('DevTools call failed'));
        else waiter?.resolve(message.result);
      } else if (message.method)
        for (const listener of this.#listeners.get(message.method) ?? [])
          listener(message.params as never);
    });
    socket.addEventListener('close', () => {
      for (const waiter of this.#pending.values())
        waiter.reject(new Error('DevTools connection closed'));
      this.#pending.clear();
    });
  }
  static connect(url: string): Promise<DevTools> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new DevTools(socket)));
      socket.addEventListener('error', () =>
        reject(new Error('DevTools connection failed')),
      );
    });
  }
  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on<T>(method: string, listener: (params: T) => void): void {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener as (params: never) => void);
    this.#listeners.set(method, list);
  }
  close(): void {
    this.#socket.close();
  }
}

/**
 * Inspect a local page in the host-registered Chromium browser. Each call
 * uses a new temporary profile (no personal cookies, extensions or sync)
 * that is deleted afterwards. Only host-allowed loopback origins load: every
 * request is intercepted through DevTools and others are blocked and
 * reported, and non-loopback traffic is also pointed at a dead proxy. This is
 * defense in depth for trusted local pages, not a network sandbox.
 */
export function createBrowserTool(services: {
  browser: { program: string; args?: readonly string[] };
  allowedOrigins: readonly string[];
  supervisor: WorkerSupervisor;
  store: Store;
  objects: ArtifactStore;
  launchTimeoutMs?: number;
  loadTimeoutMs?: number;
}) {
  const origins = new Set(
    services.allowedOrigins.map((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new DomainError('INVALID_INPUT', 'Invalid allowed origin');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !LOOPBACK.has(url.hostname) ||
        url.origin !== value.replace(/\/$/, '')
      )
        throw new DomainError(
          'INVALID_INPUT',
          'Allowed origins must be loopback http(s) origins',
        );
      return url.origin;
    }),
  );
  const allowed = (raw: string): boolean => {
    if (/^(data|blob|about):/i.test(raw)) return true;
    try {
      const url = new URL(raw);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        origins.has(url.origin)
      );
    } catch {
      return false;
    }
  };
  const launchTimeoutMs = services.launchTimeoutMs ?? 15_000;
  const loadTimeoutMs = services.loadTimeoutMs ?? 20_000;
  return defineTool({
    manifest: {
      name: 'browser.inspect',
      version: '1.0.0',
      description:
        'Load an allowed local page in an isolated headless browser and return its title, text, console errors, blocked requests and a screenshot artifact.',
      effect: 'process',
      permissions: ['browser.inspect'],
      host: 'controller',
      timeoutMs: 90_000,
      retry: 'unsafe',
      maxResultBytes: 64 * 1024,
      // Runs only the host-registered browser against host-allowed origins.
      preapproved: true,
    },
    input: z.strictObject({
      url: z.string().min(1).max(2048),
      waitMs: z.number().int().min(0).max(10_000).optional(),
      viewport: z
        .strictObject({
          width: z.number().int().min(320).max(1920),
          height: z.number().int().min(240).max(1080),
        })
        .optional(),
    }),
    output: z.strictObject({
      url: z.string(),
      status: z.number().int().nullable(),
      title: z.string(),
      text: z.string(),
      consoleErrors: z.array(z.string()),
      blockedRequests: z.array(z.string()),
      screenshot: hashSchema,
    }),
    artifacts: (output) => [output.screenshot],
    execute: async (input, context, signal) => {
      if (!allowed(input.url) || /^(data|blob|about):/i.test(input.url))
        throw new DomainError(
          'POLICY_DENIED',
          'URL is outside the allowed origins',
        );
      const viewport = input.viewport ?? { width: 1280, height: 800 };
      const profile = mkdtempSync(join(tmpdir(), 'xvant-browser-'));
      const run = services.supervisor.start({
        executable: services.browser.program,
        args: [
          ...(services.browser.args ?? []),
          '--headless=new',
          '--user-data-dir=' + profile,
          '--remote-debugging-port=0',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--disable-sync',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-default-apps',
          '--mute-audio',
          '--proxy-server=http://127.0.0.1:9',
          `--window-size=${viewport.width},${viewport.height}`,
          'about:blank',
        ],
        cwd: profile,
        workerId: context.workerId,
        attemptId: context.attemptId,
        generation: 1,
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
        // Reached only through the registry for this preapproved, host-registered browser.
        userApprovedTrustedLocal: true,
        signal,
      });
      run.endInput();
      let exited = false;
      void run.result.then(() => {
        exited = true;
      });
      let devtools: DevTools | undefined;
      try {
        const portFile = join(profile, 'DevToolsActivePort');
        const launchDeadline = Date.now() + launchTimeoutMs;
        while (!existsSync(portFile)) {
          if (exited)
            throw new DomainError('TOOL_FAILED', 'Browser exited at launch');
          if (Date.now() > launchDeadline || signal.aborted)
            throw new DomainError('TIMEOUT', 'Browser did not start');
          await delay(50);
        }
        await delay(50);
        const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new DomainError('TOOL_FAILED', 'Invalid DevTools port');
        const targets = (await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json()) as { type: string; webSocketDebuggerUrl?: string }[];
        const page = targets.find(
          (target) => target.type === 'page' && target.webSocketDebuggerUrl,
        );
        if (!page) throw new DomainError('TOOL_FAILED', 'No page target');
        devtools = await DevTools.connect(page.webSocketDebuggerUrl!);
        const tools = devtools;
        const blockedRequests: string[] = [];
        const consoleErrors: string[] = [];
        let status: number | null = null;
        tools.on<{ requestId: string; request: { url: string } }>(
          'Fetch.requestPaused',
          ({ requestId, request }) => {
            if (allowed(request.url))
              void tools.send('Fetch.continueRequest', { requestId });
            else {
              if (blockedRequests.length < 50)
                blockedRequests.push(request.url.slice(0, 300));
              void tools.send('Fetch.failRequest', {
                requestId,
                errorReason: 'BlockedByClient',
              });
            }
          },
        );
        tools.on<{
          type: string;
          args: { value?: unknown; description?: string }[];
        }>('Runtime.consoleAPICalled', ({ type, args }) => {
          if (type === 'error' && consoleErrors.length < 20)
            consoleErrors.push(
              redactSecrets(
                args
                  .map((arg) => String(arg.value ?? arg.description ?? ''))
                  .join(' ')
                  .slice(0, 500),
              ),
            );
        });
        tools.on<{ exceptionDetails: { text?: string } }>(
          'Runtime.exceptionThrown',
          ({ exceptionDetails }) => {
            if (consoleErrors.length < 20)
              consoleErrors.push(
                redactSecrets(
                  String(exceptionDetails.text ?? 'exception').slice(0, 500),
                ),
              );
          },
        );
        tools.on<{ type: string; response: { status: number } }>(
          'Network.responseReceived',
          ({ type, response }) => {
            if (type === 'Document' && status === null)
              status = response.status;
          },
        );
        const loaded = new Promise<'loaded'>((resolve) =>
          tools.on('Page.loadEventFired', () => resolve('loaded')),
        );
        await tools.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
        await tools.send('Runtime.enable');
        await tools.send('Network.enable');
        await tools.send('Page.enable');
        await tools.send('Emulation.setDeviceMetricsOverride', {
          ...viewport,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await tools.send('Page.navigate', { url: input.url });
        const outcome = await Promise.race([
          loaded,
          delay(loadTimeoutMs, 'timeout' as const),
        ]);
        if (outcome === 'timeout')
          throw new DomainError('TIMEOUT', 'Page did not finish loading');
        if (input.waitMs) await delay(input.waitMs);
        const evaluated = await tools.send<{
          result: {
            value?: { title?: unknown; url?: unknown; text?: unknown };
          };
        }>('Runtime.evaluate', {
          expression:
            '({ title: document.title, url: location.href, text: document.body ? document.body.innerText.slice(0, 4000) : "" })',
          returnByValue: true,
        });
        const shot = await tools.send<{ data: string }>(
          'Page.captureScreenshot',
          { format: 'png' },
        );
        const png = Buffer.from(shot.data, 'base64');
        if (!png.length || png.length > MAX_SCREENSHOT)
          throw new DomainError('LIMIT_EXCEEDED', 'Screenshot size is invalid');
        const value = evaluated.result.value ?? {};
        return {
          url: String(value.url ?? input.url).slice(0, 2048),
          status,
          title: redactSecrets(String(value.title ?? '').slice(0, 300)),
          text: redactSecrets(String(value.text ?? '').slice(0, 4000)),
          consoleErrors,
          blockedRequests,
          screenshot: services.store.recordArtifact(
            context.taskId,
            services.objects,
            png,
          ),
        };
      } finally {
        devtools?.close();
        services.supervisor.cancel(run.identity);
        await Promise.race([run.result, delay(10_000)]);
        rmSync(profile, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      }
    },
  });
}
