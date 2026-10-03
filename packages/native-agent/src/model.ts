import { z } from 'zod';

/**
 * The model side of XVANT's native loop, independent of the external-agent
 * adapters. A provider turns a conversation and a tool catalog into one reply;
 * it never executes tools, and nothing it returns is trusted until the loop
 * has validated it.
 */
export interface ModelToolCall {
  id: string;
  name: string;
  /** Raw JSON text exactly as the model produced it; parsed by the loop. */
  arguments: string;
}
export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ModelToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };
export interface ModelTool {
  name: string;
  description: string;
  parameters: unknown;
}
/**
 * Token counts as the endpoint reported them. Local servers estimate or omit
 * usage, so `null` means unknown and `reported` is never a billing fact.
 */
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  source: 'reported' | 'unknown';
}
export interface ModelReply {
  text: string;
  toolCalls: ModelToolCall[];
  finish: 'stop' | 'tool_calls' | 'length' | 'other';
  usage: ModelUsage;
}
export interface ModelCapabilities {
  model: string;
  /** The model answered a probe with a well-formed structured tool call. */
  toolCalls: boolean;
  contextTokens: number | null;
}
export interface ModelProvider {
  /** Stable identity recorded with the work, e.g. `lmstudio:qwen2.5-coder-7b`. */
  readonly id: string;
  readonly model: string;
  probe(signal?: AbortSignal): Promise<ModelCapabilities>;
  complete(
    request: {
      messages: ModelMessage[];
      tools: ModelTool[];
      maxTokens: number;
    },
    signal?: AbortSignal,
  ): Promise<ModelReply>;
}
/** A provider failure; `transient` errors may be retried because a model call has no effects. */
export class ModelError extends Error {
  readonly code:
    | 'MODEL_UNAVAILABLE'
    | 'MODEL_TIMEOUT'
    | 'MODEL_PROTOCOL'
    | 'MODEL_LIMIT'
    | 'MODEL_CANCELLED';
  readonly transient: boolean;
  constructor(code: ModelError['code'], message: string, transient = false) {
    super(message);
    this.code = code;
    this.transient = transient;
  }
}
/** Tool names OpenAI-style endpoints accept: dots become underscores. */
export const wireToolName = (name: string) => name.replaceAll('.', '_');
export const modelIdSchema = z.string().regex(/^[A-Za-z0-9._/:@-]{1,128}$/);
