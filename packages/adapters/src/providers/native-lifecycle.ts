import { z } from 'zod';
import { nativeIdSchema as id } from '../../../contracts/src/providers.ts';
import type { StreamKind } from './native-profiles.ts';

export const CLAUDE_FIXTURE_CLI_VERSION = '2.1.283';
const record = z.record(z.string(), z.unknown());
const control = z.object({
  type: z.literal('control_response'),
  response: z.object({
    subtype: z.literal('success'),
    request_id: id,
    response: record,
    pending_permission_requests: z.array(record).optional(),
    pending_user_dialog_requests: z.array(record).optional(),
  }),
});
const initialize = z.object({
  commands: z.array(record),
  agents: z.array(record),
  output_style: z.string(),
  available_output_styles: z.array(z.string()),
  models: z.array(record),
  account: record,
});
const init = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  uuid: id,
  session_id: id,
  apiKeySource: z.literal('none'),
  claude_code_version: z.literal(CLAUDE_FIXTURE_CLI_VERSION),
  cwd: z.string(),
  tools: z.array(z.string()).length(0),
  mcp_servers: z.array(record).length(0),
  model: z.string(),
  permissionMode: z.literal('plan'),
  slash_commands: z.array(z.string()),
  output_style: z.string(),
  skills: z.array(z.string()),
  plugins: z.array(record).length(0),
  plugin_errors: z.array(record).length(0).optional(),
  capabilities: z.array(z.string()).optional(),
});
const http = z.object({
  fixture: z.literal('http-response'),
  requestId: id,
  method: z.enum(['GET', 'POST']),
  path: z.string(),
  status: z.literal(200),
  body: z.unknown(),
});
const session = z.object({
  id,
  slug: z.string(),
  projectID: id,
  directory: z.string(),
  title: z.string(),
  version: z.string(),
  time: z.object({
    created: z.number().finite().nonnegative(),
    updated: z.number().finite().nonnegative(),
    archived: z.number().optional(),
  }),
});
const receipt = z.object({
  still_queued: z.array(id).length(0),
  cancelled: z.array(id).max(1).optional(),
});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('INVALID_EVENT');
  return result.data;
}
/** Single existing-session offline projection; HTTP envelopes are fixture-only. */
export class NativeLifecycle {
  private readonly kind: StreamKind;
  private readonly session: string;
  private readonly request: string;
  private readonly root: string;
  private state:
    | 'new'
    | 'setup'
    | 'ready'
    | 'running'
    | 'interrupting'
    | 'interrupted'
    | 'unknown' = 'new';
  private initialized = false;
  private canCancelQueued = false;
  constructor(
    kind: StreamKind,
    sessionId: string,
    requestId: string,
    root: string,
  ) {
    this.kind = kind;
    this.session = id.parse(sessionId);
    this.request = id.parse(requestId);
    this.root = root;
  }
  get ready() {
    return this.state === 'ready';
  }
  get interrupted() {
    return this.state === 'interrupted';
  }
  get canInterrupt() {
    return (
      this.state === 'running' &&
      (this.kind === 'opencode' || (this.initialized && this.canCancelQueued))
    );
  }
  private require(condition: boolean): void {
    if (!condition) {
      this.state = 'unknown';
      throw new Error('INVALID_EVENT');
    }
  }
  setup(): Record<string, unknown> {
    this.require(this.state === 'new');
    this.state = 'setup';
    return this.kind === 'claude'
      ? {
          type: 'control_request',
          request_id: 'setup',
          request: { subtype: 'initialize' },
        }
      : {
          requestId: 'setup',
          method: 'GET',
          path: '/session/' + encodeURIComponent(this.session),
          query: { directory: this.root },
        };
  }
  start(): void {
    this.require(this.ready);
    this.state = 'running';
  }
  interrupt(): Record<string, unknown> {
    this.require(this.canInterrupt);
    this.state = 'interrupting';
    return this.kind === 'claude'
      ? {
          type: 'control_request',
          request_id: 'interrupt',
          request: { subtype: 'interrupt', cancel_queued: true },
        }
      : {
          requestId: 'interrupt',
          method: 'POST',
          path: '/session/' + encodeURIComponent(this.session) + '/abort',
          query: { directory: this.root },
        };
  }
  /** True consumes a control reply. False leaves native events for NativeStream. */
  receive(message: Record<string, unknown>): boolean {
    try {
      if (this.kind === 'claude' && message.type === 'control_response') {
        const reply = parse(control, message).response;
        if (this.state === 'setup') {
          this.require(reply.request_id === 'setup');
          parse(initialize, reply.response);
          this.require(
            reply.pending_permission_requests?.length === 0 &&
              reply.pending_user_dialog_requests?.length === 0,
          );
          this.state = 'ready';
        } else {
          this.require(
            this.state === 'interrupting' && reply.request_id === 'interrupt',
          );
          const result = parse(receipt, reply.response);
          this.require(
            !result.cancelled?.some((value) => value !== this.request),
          );
          this.state = 'interrupted';
        }
        return true;
      }
      if (this.kind === 'opencode' && message.fixture === 'http-response') {
        const reply = parse(http, message);
        const path = '/session/' + encodeURIComponent(this.session);
        if (this.state === 'setup') {
          this.require(
            reply.requestId === 'setup' &&
              reply.method === 'GET' &&
              reply.path === path,
          );
          const value = parse(session, reply.body);
          this.require(
            value.id === this.session &&
              value.directory === this.root &&
              value.time.archived === undefined &&
              value.time.updated >= value.time.created,
          );
          this.state = 'ready';
        } else {
          this.require(
            this.state === 'interrupting' &&
              reply.requestId === 'interrupt' &&
              reply.method === 'POST' &&
              reply.path === path + '/abort' &&
              reply.body === true,
          );
          this.state = 'interrupted';
        }
        return true;
      }
      this.require(
        ['running', 'interrupting', 'interrupted'].includes(this.state),
      );
      if (this.kind === 'claude') {
        if (message.type === 'system' && message.subtype === 'init') {
          const value = parse(init, message);
          this.require(
            !this.initialized &&
              value.session_id === this.session &&
              value.cwd === this.root,
          );
          this.initialized = true;
          this.canCancelQueued = [
            'interrupt_receipt_v1',
            'interrupt_cancel_queued_v1',
          ].every((capability) => value.capabilities?.includes(capability));
        } else this.require(this.initialized);
      }
      return false;
    } catch (error) {
      this.state = 'unknown';
      throw error;
    }
  }
}
