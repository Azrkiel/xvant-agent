import { z } from 'zod';
import { JsonLineDecoder } from '../codex/transport.ts';
import { classifyClaude } from '../providers/failures.ts';
import { LIVE_ROUTES } from '../../../contracts/src/live.ts';
import type { NativeFailure } from '../../../contracts/src/providers.ts';

export type ClaudeProfile = 'text' | 'workspace-write';
/** Tools a worker may use without prompting, per profile. Network tools never. */
const TOOLS: Record<ClaudeProfile, string> = {
  text: 'Read,Glob,Grep',
  'workspace-write': 'Read,Glob,Grep,Edit,Write,NotebookEdit,Bash,TodoWrite',
};
/**
 * Arguments for one headless turn. The prompt goes on stdin. Only an explicit
 * session is ever used: `--session-id` to create, `--resume` to continue.
 * User MCP servers and user settings (hooks, plugins) are excluded so the
 * worker's surface is the one XVANT registered.
 */
export function claudeArgs(turn: {
  mode: 'create' | 'resume';
  sessionId: string;
  model: string;
  profile: ClaudeProfile;
}): string[] {
  if (!LIVE_ROUTES.claude.session.test(turn.sessionId))
    throw new Error('SESSION_MISMATCH');
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'text',
    turn.mode === 'create' ? '--session-id' : '--resume',
    turn.sessionId,
    '--permission-mode',
    turn.profile === 'workspace-write' ? 'acceptEdits' : 'default',
    '--allowedTools=' + TOOLS[turn.profile],
    '--disallowedTools=WebFetch,WebSearch',
    '--strict-mcp-config',
    '--setting-sources=project,local',
    ...(turn.model === 'default' ? [] : ['--model', turn.model]),
  ];
}

const initSchema = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  apiKeySource: z.string(),
  claude_code_version: z.string(),
  permissionMode: z.string(),
  model: z.string().optional(),
});
const resultSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string().max(64),
  is_error: z.boolean(),
  session_id: z.string(),
  uuid: z.string().min(1).max(128),
  result: z.unknown().optional(),
  usage: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
});
export interface ClaudeTurnResult {
  kind: 'completed' | 'failed';
  runId: string;
  text: string;
  /** Measured input+output tokens reported by the runtime. */
  tokens: number | null;
  /** Runtime's own price estimate. Under a subscription nothing is billed per call. */
  estimatedUsd: number | null;
  failure?: NativeFailure;
}
export type ClaudeSignal =
  | { kind: 'init'; model: string; auth: 'subscription' }
  | { kind: 'text'; text: string }
  | { kind: 'activity'; text: string }
  | { kind: 'retry'; text: string };

/**
 * Validates one headless stream-json turn. The first frame must be `init` for
 * the reserved session, pinned version and expected permission mode, reporting
 * no API key (`apiKeySource: none`, the subscription login). Anything else
 * throws before the host treats the turn as usable.
 */
export class ClaudeHeadlessStream {
  private readonly decoder = new JsonLineDecoder(1048576);
  private readonly session: string;
  private readonly mode: string;
  private init = false;
  private result: z.infer<typeof resultSchema> | undefined;
  private error: unknown;
  constructor(sessionId: string, profile: ClaudeProfile) {
    this.session = sessionId;
    this.mode = profile === 'workspace-write' ? 'acceptEdits' : 'default';
  }
  get started(): boolean {
    return this.init;
  }
  get finished(): boolean {
    return this.result !== undefined;
  }
  /** Returns frames to journal and signals for observers. */
  receive(bytes: Uint8Array): {
    frames: Record<string, unknown>[];
    signals: ClaudeSignal[];
  } {
    const frames = this.decoder.push(bytes);
    const signals: ClaudeSignal[] = [];
    for (const frame of frames) {
      if (this.result) throw new Error('INVALID_EVENT');
      if (!this.init) {
        const init = initSchema.safeParse(frame);
        if (!init.success) throw new Error('INVALID_EVENT');
        if (init.data.apiKeySource !== 'none')
          throw new Error('BILLING_UNVERIFIED');
        if (
          init.data.session_id !== this.session ||
          init.data.claude_code_version !== LIVE_ROUTES.claude.runtimeVersion ||
          init.data.permissionMode !== this.mode
        )
          throw new Error('SESSION_MISMATCH');
        this.init = true;
        signals.push({
          kind: 'init',
          model: init.data.model ?? 'unknown',
          auth: 'subscription',
        });
        continue;
      }
      if (frame.type === 'result') {
        const result = resultSchema.parse(frame);
        if (result.session_id !== this.session)
          throw new Error('SESSION_MISMATCH');
        this.result = result;
        continue;
      }
      if (frame.type === 'system' && frame.subtype === 'api_retry') {
        signals.push({ kind: 'retry', text: 'api_retry' });
        continue;
      }
      if (frame.type === 'assistant') {
        const message = frame.message as
          | { content?: { type?: string; text?: unknown; name?: unknown }[] }
          | undefined;
        if (typeof frame.error === 'string') this.error ??= frame.error;
        for (const part of message?.content ?? []) {
          if (part.type === 'text' && typeof part.text === 'string')
            signals.push({ kind: 'text', text: part.text.slice(0, 16384) });
          else if (part.type === 'tool_use' && typeof part.name === 'string')
            signals.push({ kind: 'activity', text: part.name.slice(0, 64) });
        }
      }
    }
    return { frames, signals };
  }
  /** Complete EOF with exactly one result. */
  end(): ClaudeTurnResult {
    this.decoder.end();
    const result = this.result;
    if (!this.init || !result) throw new Error('OPERATION_UNKNOWN');
    const usage = z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .safeParse(result.usage);
    const common = {
      runId: result.uuid,
      text:
        typeof result.result === 'string' ? result.result.slice(0, 65536) : '',
      tokens: usage.success
        ? usage.data.input_tokens + usage.data.output_tokens
        : null,
      estimatedUsd: result.total_cost_usd ?? null,
    };
    if (result.subtype === 'success' && !result.is_error)
      return { kind: 'completed', ...common };
    return {
      kind: 'failed',
      ...common,
      failure: classifyClaude(this.error, result.subtype),
    };
  }
}
