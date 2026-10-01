import type {
  ModelMessage,
  ModelProvider,
  ModelReply,
  ModelToolCall,
} from './model.ts';

export type Script = (
  messages: ModelMessage[],
  n: number,
) => Partial<ModelReply> | Promise<Partial<ModelReply>>;
/**
 * A deterministic model stub for offline tests and gates. Each reply comes
 * from a script that sees the conversation so far. It never qualifies a live
 * route: runners must use the `offline` classification with it.
 */
export class ScriptedProvider implements ModelProvider {
  readonly id: string;
  readonly model = 'scripted';
  readonly seen: ModelMessage[][] = [];
  readonly #script: Script;
  constructor(script: Script, name = 'scripted') {
    this.#script = script;
    this.id = 'stub:' + name;
  }
  async probe() {
    return { model: this.model, toolCalls: true, contextTokens: null };
  }
  async complete(
    request: { messages: ModelMessage[] },
    signal?: AbortSignal,
  ): Promise<ModelReply> {
    this.seen.push(request.messages);
    const out = await this.#script(request.messages, this.seen.length);
    if (signal?.aborted) throw new Error('aborted');
    return {
      text: '',
      toolCalls: [],
      finish: 'stop',
      usage: { inputTokens: null, outputTokens: null, source: 'unknown' },
      ...out,
    };
  }
}
let next = 0;
/** A tool call as a model would emit it (wire name, JSON-text arguments). */
export function toolCall(name: string, args: unknown): ModelToolCall {
  return {
    id: 'call_' + ++next,
    name: name.replaceAll('.', '_'),
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  };
}
/** The parsed content of the latest tool result in a conversation. */
export function lastResult(messages: ModelMessage[]): {
  status: string;
  code?: string;
  result?: Record<string, unknown>;
} {
  const tool = messages.findLast((m) => m.role === 'tool');
  return tool ? JSON.parse(tool.content) : { status: 'none' };
}
