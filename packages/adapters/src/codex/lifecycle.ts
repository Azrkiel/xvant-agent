import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import {
  nativeIdSchema,
  type NativeFailure,
} from '../../../contracts/src/providers.ts';
import { codexVersionAccepted, validateNative } from './profile.ts';
import { classifyCodex } from '../providers/failures.ts';

type Status =
  | 'new'
  | 'initializing'
  | 'ready'
  | 'opening_thread'
  | 'starting'
  | 'running'
  | 'interrupt_requested'
  | 'result_pending'
  | 'needs_attention';
type Action =
  | { kind: 'ignored' }
  | { kind: 'started'; nativeRunId: string }
  | { kind: 'output'; text: string }
  | { kind: 'completed' | 'cancelled' }
  | { kind: 'failed'; code: 'WORKER_FAILED'; failure: NativeFailure }
  | { kind: 'deny'; id: string | number; result: { decision: 'decline' } };
const envelope = z.object({
  method: z.string().max(128),
  id: z
    .union([
      z.string().min(1).max(128),
      z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    ])
    .optional(),
  params: z.unknown(),
});
function fail(code: string): never {
  throw new Error(code);
}

/** One host-owned, offline-tested attempt. No credentials, executable, automatic resume or acceptance. */
export class CodexLifecycle {
  private state: Status = 'new';
  private threadId: string | undefined;
  private opening: { mode: 'create' | 'resume'; cwd: string } | undefined;
  private observedThreadId: string | undefined;
  private runId: string | undefined;
  private terminal = false;
  private nativeFailure: NativeFailure | undefined;
  private readonly version: string;
  private readonly write: boolean;
  private readonly model: string | undefined;
  /**
   * workspace-write lets the worker edit its own worktree without prompts
   * (sandbox workspace-write, approval never). Read-only is the default.
   */
  constructor(
    version: string,
    threadId?: string,
    options: { profile?: 'read-only' | 'workspace-write'; model?: string } = {},
  ) {
    if (!codexVersionAccepted(version)) fail('VERSION_UNSUPPORTED');
    this.version = version;
    this.write = options.profile === 'workspace-write';
    this.model =
      options.model === undefined || options.model === 'default'
        ? undefined
        : z
            .string()
            .regex(/^[A-Za-z0-9._-]{1,64}$/)
            .parse(options.model);
    this.threadId =
      threadId === undefined ? undefined : nativeIdSchema.parse(threadId);
  }
  get status(): Status {
    return this.state;
  }
  get nativeRunId(): string | undefined {
    return this.runId;
  }
  get nativeSessionId(): string | undefined {
    return this.threadId;
  }
  /** First classified native error, from pinned `CodexErrorInfo` only. */
  get failure(): NativeFailure | undefined {
    return this.nativeFailure;
  }
  openThread(mode: 'create' | 'resume', cwd: string) {
    if (
      this.state !== 'ready' ||
      this.opening ||
      !['create', 'resume'].includes(mode) ||
      (mode === 'create' ? !!this.threadId : !this.threadId)
    )
      fail('ILLEGAL_TRANSITION');
    if (!isAbsolute(cwd)) fail('INVALID_INPUT');
    const params = {
      cwd: resolve(cwd),
      approvalPolicy: this.write ? ('never' as const) : ('untrusted' as const),
      approvalsReviewer: 'user' as const,
      sandbox: this.write
        ? ('workspace-write' as const)
        : ('read-only' as const),
      ...(this.model ? { model: this.model } : {}),
      ...(mode === 'resume'
        ? { threadId: this.threadId!, excludeTurns: true }
        : {}),
    };
    validateNative(
      mode === 'create' ? 'ThreadStartParams' : 'ThreadResumeParams',
      params,
    );
    this.opening = { mode, cwd: params.cwd };
    this.state = 'opening_thread';
    return {
      method: mode === 'create' ? 'thread/start' : 'thread/resume',
      params,
    };
  }
  threadOpened(result: unknown): void {
    try {
      if (this.state !== 'opening_thread' || !this.opening)
        fail('ILLEGAL_TRANSITION');
      validateNative(
        this.opening.mode === 'create'
          ? 'ThreadStartResponse'
          : 'ThreadResumeResponse',
        result,
      );
      const value = result as {
        cwd: string;
        approvalPolicy: string;
        approvalsReviewer: string;
        sandbox: { type: string; networkAccess?: boolean };
        thread: {
          id: string;
          cwd: string;
          cliVersion: string;
          status: { type: string };
          turns: { status: string }[];
        };
      };
      const id = nativeIdSchema.parse(value.thread.id);
      if (
        (this.threadId && id !== this.threadId) ||
        (this.observedThreadId && id !== this.observedThreadId) ||
        value.cwd !== this.opening.cwd ||
        value.thread.cwd !== this.opening.cwd ||
        value.approvalPolicy !== (this.write ? 'never' : 'untrusted') ||
        value.approvalsReviewer !== 'user' ||
        value.sandbox.type !== (this.write ? 'workspaceWrite' : 'readOnly') ||
        value.sandbox.networkAccess === true ||
        value.thread.cliVersion !== this.version ||
        value.thread.status.type !== 'idle' ||
        value.thread.turns.some((turn) => turn.status === 'inProgress')
      )
        fail('INVALID_EVENT');
      this.threadId = id;
      this.state = 'ready';
    } catch {
      this.state = 'needs_attention';
      fail('INVALID_EVENT');
    }
  }
  initialize() {
    if (this.state !== 'new') fail('ILLEGAL_TRANSITION');
    const params = {
      clientInfo: { name: 'xvant', version: '0.1.0', title: 'XVANT' },
    };
    validateNative('InitializeParams', params);
    this.state = 'initializing';
    return { method: 'initialize', params };
  }
  initialized(result: unknown) {
    if (this.state !== 'initializing') fail('ILLEGAL_TRANSITION');
    try {
      validateNative('InitializeResponse', result);
    } catch {
      this.state = 'needs_attention';
      fail('INVALID_EVENT');
    }
    this.state = 'ready';
    return { method: 'initialized', params: {} };
  }
  start(objective: string) {
    if (this.state !== 'ready' || !this.threadId)
      fail(
        this.state === 'new' || this.state === 'initializing'
          ? 'ILLEGAL_TRANSITION'
          : 'WORKER_BUSY',
      );
    const text = z.string().trim().min(1).max(100000).parse(objective);
    // Write turns inherit the thread's validated sandbox and approval policy.
    const params = {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(this.write
        ? {}
        : { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } }),
    };
    validateNative('TurnStartParams', params);
    this.state = 'starting';
    return { method: 'turn/start', params };
  }
  started(result: unknown): void {
    try {
      if (!['starting', 'running', 'result_pending'].includes(this.state))
        fail('ILLEGAL_TRANSITION');
      validateNative('TurnStartResponse', result);
      const { turn } = result as { turn: { id: string; status: string } };
      const id = nativeIdSchema.parse(turn.id);
      if ((this.runId && this.runId !== id) || turn.status !== 'inProgress')
        fail('INVALID_EVENT');
      this.runId = id;
      if (!this.terminal) this.state = 'running';
    } catch {
      this.state = 'needs_attention';
      fail('INVALID_EVENT');
    }
  }
  interrupt() {
    if (!this.runId || this.state !== 'running') fail('ILLEGAL_TRANSITION');
    const params = { threadId: this.threadId, turnId: this.runId };
    validateNative('TurnInterruptParams', params);
    this.state = 'interrupt_requested';
    return { method: 'turn/interrupt', params };
  }
  disconnected(): void {
    this.state = 'needs_attention';
  }
  message(input: unknown): Action {
    try {
      const message = envelope.parse(input);
      if (message.method === 'thread/started') {
        if (
          message.id !== undefined ||
          !this.opening ||
          ![
            'opening_thread',
            'ready',
            'starting',
            'running',
            'interrupt_requested',
          ].includes(this.state)
        )
          fail('INVALID_EVENT');
        validateNative('ThreadStartedNotification', message.params);
        const id = nativeIdSchema.parse(
          (message.params as { thread: { id: string } }).thread.id,
        );
        if (
          (this.threadId && id !== this.threadId) ||
          (this.observedThreadId && id !== this.observedThreadId)
        )
          fail('INVALID_EVENT');
        this.observedThreadId = id;
        return { kind: 'ignored' };
      }
      const schemas: Record<string, string> = {
        error: 'ErrorNotification',
        'turn/started': 'TurnStartedNotification',
        'turn/completed': 'TurnCompletedNotification',
        'item/agentMessage/delta': 'AgentMessageDeltaNotification',
        'item/commandExecution/requestApproval':
          'CommandExecutionRequestApprovalParams',
        'item/fileChange/requestApproval': 'FileChangeRequestApprovalParams',
      };
      const name = Object.hasOwn(schemas, message.method)
        ? schemas[message.method]
        : undefined;
      if (!name) {
        if (message.id !== undefined) fail('CAPABILITY_UNSUPPORTED');
        return { kind: 'ignored' }; // Unhandled notifications confer no authority or state change.
      }
      if (
        this.terminal ||
        ![
          'starting',
          'running',
          'interrupt_requested',
          'needs_attention',
        ].includes(this.state)
      )
        fail('INVALID_EVENT');
      validateNative(name, message.params);
      const params = message.params as {
        threadId: string;
        turnId?: string;
        turn?: {
          id: string;
          status: string;
          error?: { codexErrorInfo?: unknown } | null;
        };
        error?: { codexErrorInfo?: unknown };
        delta?: string;
      };
      if (params.threadId !== this.threadId) fail('INVALID_EVENT');
      const id = nativeIdSchema.parse(params.turn?.id ?? params.turnId);
      if (
        message.method === 'turn/started' &&
        !this.runId &&
        this.state === 'starting'
      )
        this.runId = id;
      if (id !== this.runId) fail('INVALID_EVENT');
      if (message.method === 'error') {
        if (message.id !== undefined) fail('INVALID_EVENT');
        this.nativeFailure ??= classifyCodex(params.error?.codexErrorInfo);
        fail('WORKER_FAILED');
      }
      if (message.method.endsWith('/requestApproval')) {
        if (message.id === undefined) fail('INVALID_EVENT');
        const result = { decision: 'decline' as const };
        validateNative(name.replace('Params', 'Response'), result);
        return { kind: 'deny', id: message.id, result };
      }
      if (message.id !== undefined) fail('INVALID_EVENT');
      if (message.method === 'turn/started') {
        if (params.turn!.status !== 'inProgress') fail('INVALID_EVENT');
        return { kind: 'started', nativeRunId: id };
      }
      if (message.method === 'item/agentMessage/delta') {
        if (params.delta!.length > 16384) fail('LIMIT_EXCEEDED');
        return { kind: 'output', text: params.delta! };
      }
      if (!['completed', 'interrupted', 'failed'].includes(params.turn!.status))
        fail('INVALID_EVENT');
      this.terminal = true;
      if (this.state !== 'needs_attention') this.state = 'result_pending';
      if (params.turn!.status === 'failed') {
        this.nativeFailure ??= classifyCodex(
          params.turn!.error?.codexErrorInfo,
        );
        return {
          kind: 'failed',
          code: 'WORKER_FAILED',
          failure: this.nativeFailure,
        };
      }
      return {
        kind: params.turn!.status === 'interrupted' ? 'cancelled' : 'completed',
      };
    } catch (error) {
      this.state = 'needs_attention';
      fail(
        error instanceof Error &&
          [
            'CAPABILITY_UNSUPPORTED',
            'LIMIT_EXCEEDED',
            'WORKER_FAILED',
          ].includes(error.message)
          ? error.message
          : 'INVALID_EVENT',
      );
    }
  }
}
