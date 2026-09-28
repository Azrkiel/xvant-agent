import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { nativeIdSchema as id } from '../../../contracts/src/providers.ts';

export const versions = Object.freeze({
  claude: '0.3.283',
  opencode: '1.18.33',
});
export type StreamKind = keyof typeof versions;
export const pins = JSON.parse(
  readFileSync(new URL('./native-pins.json', import.meta.url), 'utf8'),
) as Record<
  StreamKind,
  {
    version: string;
    sha256: string;
    declarations: Record<string, { name: string; required: boolean }[]>;
  }
>;
for (const kind of ['claude', 'opencode'] as const)
  if (pins[kind].version !== versions[kind])
    throw new Error('VERSION_UNSUPPORTED');
const record = z.record(z.string(), z.unknown());
const metric = z.number().finite().nonnegative();
// Supported safety-relevant projection, not full validation of nested SDK payloads.
const resultBase = {
  type: z.literal('result'),
  session_id: id,
  uuid: id,
  duration_ms: metric,
  duration_api_ms: metric,
  is_error: z.boolean(),
  num_turns: metric.int(),
  stop_reason: z.string().nullable(),
  total_cost_usd: metric,
  usage: record,
  modelUsage: record,
  permission_denials: z.array(record),
  user_message_uuid: id.optional(),
  user_message_uuids: z.array(id).max(64).optional(),
  queued_turn_count: metric.int().optional(),
  resume_reason: z.string().optional(),
  result_index: metric.int().optional(),
  deferred_tool_use: z.unknown().optional(),
};
export const claudeSchema = z.union([
  z.object({
    ...resultBase,
    subtype: z.literal('success'),
    result: z.string(),
  }),
  z.object({
    ...resultBase,
    subtype: z.enum([
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]),
    errors: z.array(z.string()),
  }),
  z.object({
    type: z.literal('control_request'),
    request_id: id,
    request: z.object({
      subtype: z.literal('can_use_tool'),
      tool_name: z.string().min(1),
      input: record,
      tool_use_id: id,
    }),
  }),
  z.object({
    type: z.enum(['system', 'assistant', 'user', 'stream_event']),
    session_id: id,
  }),
]);
const assistant = z.object({
  id,
  sessionID: id,
  parentID: id,
  role: z.literal('assistant'),
  time: z.object({ created: metric, completed: metric.optional() }),
  modelID: z.string(),
  providerID: z.string(),
  mode: z.string(),
  agent: z.string(),
  path: z.object({ cwd: z.string(), root: z.string() }),
  cost: metric,
  tokens: z.object({
    input: metric,
    output: metric,
    reasoning: metric,
    cache: z.object({ read: metric, write: metric }),
  }),
  finish: z.string().optional(),
  error: z.unknown().optional(),
});
export const opencodeSchema = z.union([
  z.object({
    id,
    type: z.literal('message.updated'),
    properties: z.object({ sessionID: id, info: assistant }),
  }),
  z.object({
    id,
    type: z.literal('permission.asked'),
    properties: z.object({
      id,
      sessionID: id,
      permission: z.string(),
      patterns: z.array(z.string()),
      always: z.array(z.string()),
      metadata: record,
      tool: z.object({ messageID: id, callID: id }).optional(),
    }),
  }),
  z.object({
    id,
    type: z.literal('session.idle'),
    properties: z.object({ sessionID: id }),
  }),
  z.object({
    id,
    type: z.literal('session.error'),
    properties: z.object({
      sessionID: id.optional(),
      error: z.unknown().optional(),
    }),
  }),
]);
export function validateMessage(kind: StreamKind, input: unknown) {
  const parsed = (kind === 'claude' ? claudeSchema : opencodeSchema).safeParse(
    input,
  );
  if (!parsed.success) throw new Error('INVALID_EVENT');
  return parsed.data;
}
