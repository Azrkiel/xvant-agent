import { z } from 'zod';
import { nativeIdSchema } from '../../../contracts/src/providers.ts';
import { CODEX_VERSION, validateNative } from './profile.ts';

type Status =
  | 'new'
  | 'initializing'
  | 'ready'
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
  | { kind: 'failed'; code: 'WORKER_FAILED' }
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
  private readonly threadId: string;
  private runId: string | undefined;
  private terminal = false;
  constructor(version: string, threadId: string) {
    if (version !== CODEX_VERSION) fail('VERSION_UNSUPPORTED');
    this.threadId = nativeIdSchema.parse(threadId);
  }
  get status(): Status {
    return this.state;
  }
  get nativeRunId(): string | undefined {
    return this.runId;
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
    if (this.state !== 'ready')
      fail(
        this.state === 'new' || this.state === 'initializing'
          ? 'ILLEGAL_TRANSITION'
          : 'WORKER_BUSY',
      );
    const text = z.string().trim().min(1).max(10000).parse(objective);
    const params = {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly' },
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
      const schemas: Record<string, string> = {
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
        turn?: { id: string; status: string };
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
      return params.turn!.status === 'failed'
        ? { kind: 'failed', code: 'WORKER_FAILED' }
        : {
            kind:
              params.turn!.status === 'interrupted' ? 'cancelled' : 'completed',
          };
    } catch (error) {
      this.state = 'needs_attention';
      fail(
        error instanceof Error &&
          ['CAPABILITY_UNSUPPORTED', 'LIMIT_EXCEEDED'].includes(error.message)
          ? error.message
          : 'INVALID_EVENT',
      );
    }
  }
}
