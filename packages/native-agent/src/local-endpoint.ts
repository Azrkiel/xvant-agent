import { z } from 'zod';
import {
  ModelError,
  modelIdSchema,
  wireToolName,
  type ModelCapabilities,
  type ModelMessage,
  type ModelProvider,
  type ModelReply,
  type ModelTool,
} from './model.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const toolCallSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().max(256),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
});
const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(toolCallSchema).max(64).nullable().optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .nullable()
    .optional(),
});
const modelsSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        max_context_length: z.number().int().positive().optional(),
        loaded_context_length: z.number().int().positive().optional(),
      }),
    )
    .max(1000),
});

/**
 * An OpenAI-compatible chat endpoint on this machine (LM Studio, llama.cpp,
 * Ollama). Only loopback HTTP is accepted and no credential is ever sent, so
 * this route cannot reach a metered cloud API.
 */
export class LocalEndpointProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;
  constructor(options: {
    baseUrl: string;
    model: string;
    /** Names the server in the recorded identity, e.g. `lmstudio`. */
    server?: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    fetch?: typeof fetch;
  }) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new ModelError('MODEL_UNAVAILABLE', 'Invalid endpoint URL');
    }
    if (
      url.protocol !== 'http:' ||
      !LOOPBACK.has(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ModelError(
        'MODEL_UNAVAILABLE',
        'Only a credential-free loopback HTTP endpoint is allowed',
      );
    if (!modelIdSchema.safeParse(options.model).success)
      throw new ModelError('MODEL_UNAVAILABLE', 'Invalid model identifier');
    this.#base = url.href.replace(/\/+$/, '');
    this.model = options.model;
    this.id = (options.server ?? 'local') + ':' + options.model;
    this.#timeoutMs = options.timeoutMs ?? 300_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
    this.#fetch = options.fetch ?? fetch;
  }
  async #request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(this.#base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers:
          body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: combined,
      });
    } catch {
      if (signal?.aborted)
        throw new ModelError('MODEL_CANCELLED', 'Model call cancelled');
      if (timeout.aborted)
        throw new ModelError('MODEL_TIMEOUT', 'Model call timed out', true);
      throw new ModelError('MODEL_UNAVAILABLE', 'Endpoint unreachable', true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ModelError(
        'MODEL_UNAVAILABLE',
        'Endpoint returned HTTP ' + response.status,
        response.status >= 500 || response.status === 429,
      );
    }
    const text = await this.#readBounded(response, signal);
    try {
      return JSON.parse(text);
    } catch {
      throw new ModelError('MODEL_PROTOCOL', 'Endpoint returned invalid JSON');
    }
  }
  async #readBounded(
    response: Response,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > this.#maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ModelError('MODEL_LIMIT', 'Response exceeds the limit');
    }
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.#maxResponseBytes) {
          await reader.cancel().catch(() => {});
          throw new ModelError('MODEL_LIMIT', 'Response exceeds the limit');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (signal?.aborted)
        throw new ModelError('MODEL_CANCELLED', 'Model call cancelled');
      throw new ModelError('MODEL_TIMEOUT', 'Response interrupted', true);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async probe(signal?: AbortSignal): Promise<ModelCapabilities> {
    const models = modelsSchema.safeParse(
      await this.#request('/models', undefined, signal),
    );
    if (!models.success)
      throw new ModelError('MODEL_PROTOCOL', 'Unexpected model list');
    const entry = models.data.data.find((m) => m.id === this.model);
    if (!entry)
      throw new ModelError('MODEL_UNAVAILABLE', 'Model is not available');
    let toolCalls = false;
    try {
      const reply = await this.complete(
        {
          messages: [
            {
              role: 'user',
              content:
                'Call the record_number tool with value 7. Do not answer in text.',
            },
          ],
          tools: [
            {
              name: 'record_number',
              description: 'Record a number.',
              parameters: {
                type: 'object',
                properties: { value: { type: 'integer' } },
                required: ['value'],
                additionalProperties: false,
              },
            },
          ],
          maxTokens: 256,
        },
        signal,
      );
      const call = reply.toolCalls[0];
      toolCalls =
        reply.toolCalls.length === 1 &&
        call!.name === 'record_number' &&
        (JSON.parse(call!.arguments) as { value?: unknown }).value === 7;
    } catch (error) {
      if (error instanceof ModelError && error.code === 'MODEL_CANCELLED')
        throw error;
      toolCalls = false;
    }
    return {
      model: this.model,
      toolCalls,
      contextTokens:
        entry.loaded_context_length ?? entry.max_context_length ?? null,
    };
  }
  async complete(
    request: {
      messages: ModelMessage[];
      tools: ModelTool[];
      maxTokens: number;
    },
    signal?: AbortSignal,
  ): Promise<ModelReply> {
    const body = {
      model: this.model,
      stream: false,
      temperature: 0,
      max_tokens: request.maxTokens,
      messages: request.messages.map((m) =>
        m.role === 'tool'
          ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
          : m.role === 'assistant' && m.toolCalls?.length
            ? {
                role: 'assistant',
                content: m.content,
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : { role: m.role, content: m.content },
      ),
      ...(request.tools.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: {
                name: wireToolName(t.name),
                description: t.description,
                parameters: t.parameters,
              },
            })),
            tool_choice: 'auto',
          }
        : {}),
    };
    const parsed = completionSchema.safeParse(
      await this.#request('/chat/completions', body, signal),
    );
    if (!parsed.success)
      throw new ModelError('MODEL_PROTOCOL', 'Unexpected completion shape');
    const choice = parsed.data.choices[0]!;
    const usage = parsed.data.usage;
    const finish = choice.finish_reason;
    return {
      text: choice.message.content ?? '',
      toolCalls: (choice.message.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? 'call_' + index,
        name: call.function.name,
        arguments:
          typeof call.function.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call.function.arguments),
      })),
      finish:
        finish === 'stop' || finish === 'tool_calls' || finish === 'length'
          ? finish
          : 'other',
      usage:
        usage &&
        (usage.prompt_tokens !== undefined ||
          usage.completion_tokens !== undefined)
          ? {
              inputTokens: usage.prompt_tokens ?? null,
              outputTokens: usage.completion_tokens ?? null,
              source: 'reported',
            }
          : { inputTokens: null, outputTokens: null, source: 'unknown' },
    };
  }
}
