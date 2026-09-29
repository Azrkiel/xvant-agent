import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from '../../../packages/storage/src/store.ts';
import type {
  ProviderDispatch,
  ProviderConnection,
} from '../../../packages/storage/src/providers.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import { NativeStream } from '../../../packages/adapters/src/providers/native-stream.ts';
import { NativeLifecycle } from '../../../packages/adapters/src/providers/native-lifecycle.ts';
import { versions } from '../../../packages/adapters/src/providers/native-profiles.ts';
import {
  OpenCodeEndpoint,
  createEndpointSecret,
  parseAnnouncement,
  secretDigest,
} from '../../../packages/adapters/src/opencode/endpoint.ts';
import type {
  InterruptAdmission,
  NativeFailure,
} from '../../../packages/contracts/src/providers.ts';
import { NativeVerifier } from './native-verifier.ts';
import { NativeReviewController } from './native-review.ts';

const scenarioSchema = z.enum([
  'success',
  'permission',
  'interrupt',
  'error',
  'quota-error',
  'setup-mismatch',
  'create-permission',
  'no-auth',
  'wrong-version',
  'announce-remote',
]);
type Checks = Record<string, { executable: string; args: readonly string[] }>;
interface Wire {
  requestId: string;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}
const SERVE_ARGS = ['serve', '--hostname=127.0.0.1', '--port=0'] as const;

/**
 * OpenCode over an owned, authenticated loopback HTTP endpoint. Launches only
 * the fixed synthetic server; the per-launch secret lives in memory and in the
 * child environment only. Journals the endpoint binding before session traffic.
 */
export class OfflineOpenCodeHttpController {
  private readonly store: Store;
  private readonly workspaces: Record<string, string>;
  private readonly checks: Checks;
  private readonly supervisor = new WorkerSupervisor();
  private readonly verifier: NativeVerifier;
  private readonly review: NativeReviewController;
  private readonly timeout: number;
  private readonly fault: (point: string) => void;
  private readonly interrupts = new Map<
    string,
    (actorId: string) => InterruptAdmission
  >();
  private stopped = false;
  constructor(
    store: Store,
    objects: ArtifactStore,
    workspaces: Record<string, string>,
    checks: Checks,
    options: { timeoutMs?: number; fault?: (point: string) => void } = {},
  ) {
    this.store = store;
    this.workspaces = structuredClone(workspaces);
    this.checks = structuredClone(checks);
    this.timeout = options.timeoutMs ?? 5000;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 60000
    )
      throw new Error('INVALID_INPUT');
    this.fault = options.fault ?? (() => {});
    this.verifier = new NativeVerifier(store, objects, workspaces, checks, {
      timeoutMs: this.timeout,
    });
    this.review = new NativeReviewController(store, objects);
  }
  get activeCount(): number {
    return this.supervisor.activeCount;
  }
  /** Same host-only admission contract as the other offline controllers. */
  interrupt(connectionId: string, actorId: string): InterruptAdmission {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    const admit = this.interrupts.get(connectionId);
    if (!admit) throw new Error('NOT_FOUND');
    return admit(actorId);
  }
  async run(
    input: ProviderDispatch,
    scenarioInput = 'success',
    modeInput: 'resume' | 'create' = 'resume',
  ) {
    if (this.stopped) throw new Error('CONTROLLER_STOPPED');
    const scenario = scenarioSchema.parse(scenarioInput);
    const mode = z.enum(['resume', 'create']).parse(modeInput);
    if (
      input.worker.runtimeKind !== 'opencode' ||
      input.worker.runtimeVersion !== versions.opencode
    )
      throw new Error('VERSION_UNSUPPORTED');
    const root = this.workspaces[input.workspaceId];
    if (!Object.hasOwn(this.workspaces, input.workspaceId) || !root)
      throw new Error('WORKSPACE_UNAVAILABLE');
    const task = this.store.getTask(input.taskId);
    if (task.requiredCheckIds.some((id) => !Object.hasOwn(this.checks, id)))
      throw new Error('VERIFIER_UNAVAILABLE');
    const connection = this.store.providers.reserve(
      mode === 'create'
        ? {
            ...input,
            worker: {
              ...input.worker,
              nativeSessionId: 'pending:' + input.connectionId,
            },
          }
        : input,
    );
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat();
      } catch {
        this.stop();
      }
    }, this.store.heartbeatIntervalMs);
    heartbeat.unref();
    try {
      return await this.execute(
        connection,
        scenario,
        root,
        mode,
        task.objective,
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async execute(
    connection: ProviderConnection,
    scenario: string,
    root: string,
    mode: 'resume' | 'create',
    objective: string,
  ) {
    const id = connection.connectionId,
      token = connection.token;
    const life = new NativeLifecycle(
      'opencode',
      connection.worker.nativeSessionId,
      connection.attemptId,
      root,
      mode,
    );
    const stream = new NativeStream(
      'opencode',
      connection.worker.runtimeVersion,
      connection.worker.nativeSessionId,
      connection.attemptId,
      {
        beforeReceive: (message) => {
          this.store.providers.recordMessage(id, token, message);
        },
      },
    );
    const secret = createEndpointSecret();
    let run: ReturnType<WorkerSupervisor['start']> | undefined;
    let endpoint: OpenCodeEndpoint | undefined;
    let writes = Promise.resolve(),
      failed = false,
      sequence = 0,
      prompted = false,
      interruptRequested = false,
      interruptible = false,
      shuttingDown = false;
    let announced!: (line: string) => void, refused!: (error: Error) => void;
    const announcement = new Promise<string>((resolve, reject) => {
      announced = resolve;
      refused = reject;
    });
    void announcement.catch(() => {});
    let sseClosed!: (clean: boolean) => void;
    const sse = new Promise<boolean>((resolve) => {
      sseClosed = resolve;
    });
    const classify = (failure: NativeFailure | undefined) => {
      if (failure && !interruptRequested)
        this.store.providers.recordFailure(id, token, failure);
    };
    const fail = () => {
      failed = true;
      stream.cancel();
      refused(new Error('OPERATION_UNKNOWN'));
      try {
        classify(stream.failure);
      } catch {
        /* Advisory only; uncertainty is recorded below. */
      }
      try {
        this.store.providers.unknown(id, token);
      } catch {
        /* Recovery retains the reservation if fenced. */
      }
      endpoint?.close();
      if (run) this.supervisor.cancel(run.identity);
    };
    const persist = (method: string, wire: unknown) => {
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      // Descriptors never contain the endpoint secret or authorization header.
      const frame = JSON.stringify(wire) + '\n';
      this.store.providers.recordIntent(id, token, {
        id: ++sequence,
        method,
        frame,
      });
      this.store.providers.assertWritable(id, token);
    };
    const send = async (method: string, wire: Wire) => {
      persist(method, wire);
      const query = wire.query
        ? '?' + new URLSearchParams(wire.query).toString()
        : '';
      const reply = await endpoint!.request(
        wire.method,
        wire.path + query,
        wire.body,
      );
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      const envelope = {
        fixture: 'http-response',
        requestId: wire.requestId,
        method: wire.method,
        path: wire.path,
        status: reply.status,
        body: reply.body,
      };
      this.store.providers.recordMessage(id, token, envelope);
      return envelope;
    };
    const observeInterruptible = () => {
      if (!interruptible && prompted && life.interruptSupport === 'ready') {
        interruptible = true;
        this.fault('opencode.interruptible');
      }
    };
    const maybeShutdown = () => {
      if (
        !shuttingDown &&
        !failed &&
        stream.status === 'result_pending' &&
        (!interruptRequested || life.interrupted)
      ) {
        shuttingDown = true;
        writes = writes.then(() => {
          run!.endInput();
        });
      }
    };
    this.interrupts.set(id, (actorId) => {
      if (interruptRequested) return { status: 'already_requested' };
      if (
        failed ||
        !prompted ||
        life.interruptSupport !== 'ready' ||
        stream.status !== 'running'
      )
        throw new Error('NOT_INTERRUPTIBLE');
      this.store.providers.requestInterrupt(id, token, actorId);
      interruptRequested = true;
      this.fault('opencode.after_interrupt_request');
      writes = writes.then(async () => {
        const reply = await send(
          'session/abort',
          life.interrupt() as unknown as Wire,
        );
        life.receive(reply);
        this.fault('opencode.after_interrupt');
        maybeShutdown();
      });
      void writes.catch(fail);
      return { status: 'requested' };
    });
    try {
      persist('opencode/serve', {
        args: SERVE_ARGS,
        env: ['OPENCODE_SERVER_PASSWORD'],
        credentialSha256: secretDigest(secret),
      });
      this.fault('opencode.before_launch');
      if (this.stopped) throw new Error('CONTROLLER_STOPPED');
      this.store.providers.assertWritable(id, token);
      let banner = '';
      run = this.supervisor.start({
        executable: process.execPath,
        args: [
          fileURLToPath(
            new URL(
              '../../../tests/fixtures/opencode-server.mjs',
              import.meta.url,
            ),
          ),
          ...SERVE_ARGS,
          scenario,
        ],
        env: { OPENCODE_SERVER_PASSWORD: secret },
        cwd: root,
        workerId: connection.worker.id,
        attemptId: connection.attemptId,
        generation: connection.generation,
        timeoutMs: this.timeout,
        maxOutputBytes: 65536,
        userApprovedTrustedLocal: true,
        interactive: {
          onStdout: (bytes) => {
            // Only the one-line announcement is expected on stdout.
            if (banner.includes('\n') || banner.length + bytes.length > 4096)
              return fail();
            banner += bytes.toString('utf8');
            const newline = banner.indexOf('\n');
            if (newline >= 0) {
              if (newline !== banner.length - 1) return fail();
              announced(banner.slice(0, newline));
            }
          },
        },
      });
      void run.result.then(() => refused(new Error('OPERATION_UNKNOWN')));
      const origin = parseAnnouncement(await announcement);
      endpoint = new OpenCodeEndpoint(origin, secret, this.timeout);
      const { version } = await endpoint.verify();
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      this.store.providers.bindEndpoint(id, token, {
        origin,
        credentialSha256: secretDigest(secret),
        version,
      });
      this.fault('opencode.after_endpoint');
      // Subscribe before any prompt so no event can be missed.
      await endpoint.events(
        root,
        (chunk) => {
          try {
            for (const action of stream.receive(chunk)) {
              writes = writes.then(async () => {
                const reply = await send('permission/reply', {
                  ...(action.wire as Omit<Wire, 'requestId'>),
                  requestId: action.requestId,
                  query: { directory: root },
                });
                if (reply.status !== 200 || reply.body !== true)
                  throw new Error('INVALID_EVENT');
                stream.denialWritten(action.requestId);
                maybeShutdown();
              });
            }
            maybeShutdown();
            void writes.catch(fail);
          } catch {
            fail();
          }
        },
        (clean) => sseClosed(clean),
      );
      const setup = await send(
        mode === 'create' ? 'session/create' : 'session/get',
        life.setup() as unknown as Wire,
      );
      life.receive(setup);
      if (mode === 'create') {
        this.store.providers.bindSession(id, token, life.nativeSessionId);
        stream.bindSession(life.nativeSessionId);
        this.fault('opencode.after_session');
      }
      this.fault('opencode.after_setup');
      if (failed || this.stopped) throw new Error('OPERATION_UNKNOWN');
      life.start();
      // The host message ID correlates the assistant reply's parentID.
      const prompt = await send('session/prompt', {
        requestId: 'prompt',
        method: 'POST',
        path:
          '/session/' +
          encodeURIComponent(life.nativeSessionId) +
          '/prompt_async',
        query: { directory: root },
        body: {
          messageID: connection.attemptId,
          parts: [{ type: 'text', text: objective }],
        },
      });
      if (prompt.status !== 204) throw new Error('INVALID_EVENT');
      prompted = true;
      observeInterruptible();
      maybeShutdown();
      const stopped = await run.result;
      const cleanEvents = await sse;
      await writes;
      if (
        failed ||
        this.stopped ||
        !cleanEvents ||
        stopped.reason !== 'exited' ||
        stopped.exitCode !== 0 ||
        stopped.outputTruncated
      )
        throw new Error('OPERATION_UNKNOWN');
      const result = stream.end();
      if (interruptRequested && !life.interrupted)
        throw new Error('OPERATION_UNKNOWN');
      this.fault('opencode.after_shutdown');
      if (this.stopped) throw new Error('CONTROLLER_STOPPED');
      this.store.providers.bindRun(id, token, result.nativeMessageId);
      classify(result.failure);
      this.store.providers.finish(
        id,
        token,
        result.nativeMessageId,
        interruptRequested ? 'cancelled' : result.kind,
      );
      if (result.kind === 'completed' && !interruptRequested) {
        const verification = await this.verifier.verify(id, token, {
          stopped: true,
        });
        if (verification.status === 'passed' && !this.stopped) {
          this.fault('opencode.before_review');
          if (this.stopped) throw new Error('CONTROLLER_STOPPED');
          this.review.prepare(
            id,
            id,
            this.store.getTask(connection.taskId).rowVersion,
          );
        }
      }
    } catch {
      fail();
    } finally {
      this.interrupts.delete(id);
      stream.cancel();
      endpoint?.close();
      if (run) {
        if (failed) this.supervisor.cancel(run.identity);
        await run.result;
      }
      await writes.catch(() => {});
    }
    return this.store.getTask(connection.taskId);
  }
  stop(): void {
    this.stopped = true;
    this.supervisor.stopAll();
    this.verifier.stop();
  }
}
