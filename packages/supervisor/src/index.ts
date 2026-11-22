import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import {
  captureProcess,
  type ProcessStartIdentity,
} from './process-identity.ts';
import { authorizeExecution } from '../../policy/src/index.ts';

export interface RunIdentity {
  readonly workerId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly nonce: string;
  readonly startedAt: number;
}
export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  workerId: string;
  attemptId: string;
  generation: number;
  timeoutMs: number;
  maxOutputBytes: number;
  userApprovedTrustedLocal: boolean;
  signal?: AbortSignal;
  /** Host journal callback, called before this supervisor returns the child handle. */
  onProcess?: ((identity: ProcessStartIdentity) => void) | undefined;
  /** Extra variables layered over the inherited environment (e.g. a per-launch secret). */
  env?: Readonly<Record<string, string>>;
  /** Pass args to the Windows command line unquoted (for cmd.exe /s /c). */
  windowsVerbatimArguments?: boolean;
  /** Start with an empty environment before applying the launch variables. */
  inheritEnv?: false;
  /** Inherited variables to remove, e.g. API keys that would change billing. */
  unsetEnv?: readonly string[];
  /**
   * Streamed stdout. With 
etainStdout: false the bytes go only to the
   * callback, so long-running sessions are not bounded by maxOutputBytes.
   */
  interactive?: { onStdout: (bytes: Buffer) => void; retainStdout?: boolean };
}
export interface ProcessResult {
  identity: RunIdentity;
  reason:
    'exited' | 'timeout' | 'cancelled' | 'spawn_failed' | 'needs_attention';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  /** Best-effort tree shutdown is not hostile-process containment. */
  treeContainment: false;
}
interface OwnedRun {
  identity: RunIdentity;
  stop: (reason: 'timeout' | 'cancelled') => void;
}

/** Only live child handles created by this instance can be interrupted; no PID API. */
export class WorkerSupervisor {
  readonly #runs = new Map<string, OwnedRun>();
  get activeCount() {
    return this.#runs.size;
  }

  start(request: ProcessRequest): {
    identity: RunIdentity;
    result: Promise<ProcessResult>;
    write: (frame: string) => Promise<void>;
    endInput: () => void;
  } {
    const decision = authorizeExecution({
      profile: 'trusted-local',
      userApproved: request.userApprovedTrustedLocal,
    });
    if (!decision.allowed)
      throw new Error(`${decision.code}: ${decision.reason}`);
    if (
      !request.workerId ||
      !request.attemptId ||
      !Number.isSafeInteger(request.generation) ||
      request.generation < 1 ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(request.maxOutputBytes) ||
      request.maxOutputBytes < 0 ||
      request.maxOutputBytes > 16_777_216 ||
      !request.executable ||
      !isAbsolute(request.cwd) ||
      Object.entries(request.env ?? {}).some(
        ([key, value]) =>
          !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) ||
          typeof value !== 'string' ||
          value.length > 4096 ||
          value.includes('\u0000'),
      )
    )
      throw new Error('INVALID_INPUT: invalid process request');
    if (
      (request.unsetEnv ?? []).some(
        (key) =>
          typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key),
      )
    )
      throw new Error('INVALID_INPUT: invalid process request');
    if (request.signal?.aborted)
      throw new Error('POLICY_DENIED: already aborted');
    const identity = Object.freeze({
      workerId: request.workerId,
      attemptId: request.attemptId,
      generation: request.generation,
      nonce: randomUUID(),
      startedAt: Date.now(),
    });
    // Snapshot mutable caller inputs before dispatch.
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform === 'linux',
      windowsVerbatimArguments: request.windowsVerbatimArguments === true,
      ...(request.env || request.unsetEnv || request.inheritEnv === false
        ? {
            env: childEnv(
              request.env ?? {},
              request.unsetEnv ?? [],
              request.inheritEnv !== false,
            ),
          }
        : {}),
      stdio: [request.interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const budget = request.maxOutputBytes;
    const signal = request.signal;
    let resolveResult!: (value: ProcessResult) => void;
    const result = new Promise<ProcessResult>((resolve) => {
      resolveResult = resolve;
    });
    let reason: ProcessResult['reason'] = 'exited';
    let settled = false;
    let used = 0;
    let truncated = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const capture = (target: Buffer[], chunk: Buffer) => {
      const size = Math.min(chunk.length, budget - used);
      if (size > 0) target.push(Buffer.from(chunk.subarray(0, size)));
      used += size;
      if (size < chunk.length) truncated = true;
    };
    const onStdout = request.interactive?.onStdout;
    const retain = request.interactive?.retainStdout !== false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (retain) capture(stdout, chunk);
      if (onStdout) {
        if (truncated) {
          stop('cancelled');
          return;
        }
        try {
          onStdout(chunk);
        } catch {
          stop('cancelled');
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));
    // Decode only complete UTF-8 prefixes; replacement characters can exceed the byte budget.
    const decode = (parts: Buffer[]) => {
      const raw = Buffer.concat(parts);
      const encoded = Buffer.from(raw.toString('utf8'));
      if (encoded.length > raw.length) truncated = true;
      return new TextDecoder('utf-8').decode(encoded.subarray(0, raw.length), {
        stream: true,
      });
    };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      if (
        reason !== 'needs_attention' ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        this.#runs.delete(identity.nonce);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      resolveResult({
        identity,
        reason,
        exitCode,
        stdout: decode(stdout),
        stderr: decode(stderr),
        outputTruncated: truncated,
        treeContainment: false,
      });
    };
    const stop = (cause: 'timeout' | 'cancelled') => {
      if (settled) {
        if (reason === 'needs_attention') void terminateOwned(child, true);
        return;
      }
      if (reason !== 'exited') return;
      reason = cause;
      void terminateOwned(child, false).then(() => {
        if (settled) return;
        escalation = setTimeout(() => {
          void terminateOwned(child, true).then((ok) => {
            // Windows taskkill can lose a race with the owned process exiting
            // (exit 128). Its failure is not the final shutdown observation:
            // await close, or retain uncertainty at the unchanged deadline.
            if (!ok && !settled && process.platform !== 'win32')
              reason = 'needs_attention';
          });
        }, 100);
      });
      // Resolution itself must remain bounded when inherited pipes or termination fail.
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        reason = 'needs_attention';
        finish(child.exitCode);
      }, 7000);
    };
    const onAbort = () => stop('cancelled');
    child.stdin?.on('error', () => stop('cancelled'));
    this.#runs.set(identity.nonce, { identity, stop });
    child.once('error', () => {
      reason = 'spawn_failed';
      finish(null);
    });
    child.once('close', (code) => {
      this.#runs.delete(identity.nonce);
      finish(code);
    });
    deadline = setTimeout(() => stop('timeout'), request.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (request.onProcess && child.pid) {
      const started = captureProcess(child.pid);
      if (started) {
        try {
          request.onProcess(started);
        } catch (error) {
          stop('cancelled');
          throw error;
        }
      }
    }
    return {
      identity,
      result,
      write: async (frame: string) => {
        if (
          settled ||
          !child.stdin ||
          !child.stdin.writable ||
          child.stdin.writableEnded
        )
          throw new Error('CONNECTION_CLOSED');
        if (
          Buffer.byteLength(frame) > 65536 ||
          child.stdin.writableLength > 65536
        )
          throw new Error('LIMIT_EXCEEDED');
        await new Promise<void>((resolve, reject) =>
          child.stdin!.write(frame, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      },
      endInput: () => {
        child.stdin?.end();
      },
    };
  }

  cancel(identity: RunIdentity): boolean {
    const run = this.#runs.get(identity.nonce);
    if (
      !run ||
      run.identity.workerId !== identity.workerId ||
      run.identity.attemptId !== identity.attemptId ||
      run.identity.generation !== identity.generation ||
      run.identity.startedAt !== identity.startedAt
    )
      return false;
    run.stop('cancelled');
    return true;
  }

  stopAll(): void {
    for (const run of this.#runs.values()) run.stop('cancelled');
  }
}

/** Write text larger than one bounded frame as sequential UTF-8-safe pieces. */
export async function writeChunked(
  write: (frame: string) => Promise<void>,
  text: string,
  maxBytes = 60000,
): Promise<void> {
  let piece = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) {
      await write(piece);
      piece = '';
      bytes = 0;
    }
    piece += char;
    bytes += size;
  }
  if (piece) await write(piece);
}

function childEnv(
  overlay: Readonly<Record<string, string>>,
  unset: readonly string[],
  inherit: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = inherit
    ? { ...process.env, ...overlay }
    : { ...overlay };
  // Windows variable names are case-insensitive.
  const drop = new Set(unset.map((key) => key.toUpperCase()));
  for (const key of Object.keys(env))
    if (drop.has(key.toUpperCase())) delete env[key];
  return env;
}

async function terminateOwned(
  child: ChildProcess,
  force: boolean,
): Promise<boolean> {
  // An exited root may have been reused; never send a Windows PID command after exit.
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return false;
  if (process.platform === 'linux') {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
  const windowsRoot = process.env.SystemRoot;
  if (!windowsRoot || !isAbsolute(windowsRoot)) return false;
  return new Promise((resolve) => {
    const killer = spawn(
      join(windowsRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    );
    const limit = setTimeout(() => {
      killer.kill();
      resolve(false);
    }, 2500);
    killer.once('error', () => {
      clearTimeout(limit);
      resolve(false);
    });
    killer.once('close', (code) => {
      clearTimeout(limit);
      resolve(code === 0);
    });
  });
}
