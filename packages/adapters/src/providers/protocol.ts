import { z } from 'zod';
import {
  nativeIdSchema,
  providerKindSchema,
} from '../../../contracts/src/providers.ts';
import type { ProviderKind } from '../../../contracts/src/providers.ts';
import { ProviderRegistry } from './registry.ts';

// Narrow, synthetic subsets of documented results, NOT pinned native protocol schemas.
// A live transport must validate its own versioned full schema before using these mappings.
const codexResult = z.object({
  method: z.literal('turn/completed'),
  params: z.object({
    threadId: nativeIdSchema,
    turn: z.object({
      id: nativeIdSchema,
      status: z.enum(['completed', 'interrupted', 'failed']),
    }),
  }),
});
const claudeResult = z.object({
  // Host-owned invocation ID, not a field supplied by the Claude protocol.
  invocationId: nativeIdSchema,
  message: z.object({
    type: z.literal('result'),
    session_id: nativeIdSchema,
    subtype: z.enum([
      'success',
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]),
    is_error: z.boolean(),
  }),
});
const opencodeResult = z.object({
  type: z.literal('message.updated'),
  properties: z.object({
    info: z.object({
      id: nativeIdSchema,
      sessionID: nativeIdSchema,
      role: z.literal('assistant'),
      time: z.object({
        created: z.number().nonnegative(),
        completed: z.number().nonnegative(),
      }),
      finish: z.literal('stop'),
      error: z.unknown().optional(),
    }),
  }),
});
type Outcome =
  | { kind: 'completed' | 'cancelled' }
  | { kind: 'failed'; code: 'WORKER_FAILED' };
export function normalizeFixture(
  kindInput: ProviderKind,
  input: unknown,
  session: string,
  run: string,
): Outcome {
  const kind = providerKindSchema.parse(kindInput);
  nativeIdSchema.parse(session);
  nativeIdSchema.parse(run);
  let actualSession: string, actualRun: string, result: Outcome;
  if (kind === 'codex') {
    const { params } = codexResult.parse(input);
    actualSession = params.threadId;
    actualRun = params.turn.id;
    result =
      params.turn.status === 'failed'
        ? { kind: 'failed', code: 'WORKER_FAILED' }
        : {
            kind:
              params.turn.status === 'interrupted' ? 'cancelled' : 'completed',
          };
  } else if (kind === 'claude') {
    const value = claudeResult.parse(input);
    actualSession = value.message.session_id;
    actualRun = value.invocationId;
    result =
      value.message.subtype === 'success' && !value.message.is_error
        ? { kind: 'completed' }
        : { kind: 'failed', code: 'WORKER_FAILED' };
  } else {
    const { info } = opencodeResult.parse(input).properties;
    actualSession = info.sessionID;
    actualRun = info.id;
    result =
      info.error !== undefined
        ? { kind: 'failed', code: 'WORKER_FAILED' }
        : { kind: 'completed' };
  }
  if (actualSession !== session || actualRun !== run)
    throw new Error('INVALID_EVENT');
  return result;
}
export function fixtureFor(
  kind: ProviderKind,
  session: string,
  run: string,
): unknown {
  switch (kind) {
    case 'codex':
      return {
        method: 'turn/completed',
        params: { threadId: session, turn: { id: run, status: 'completed' } },
      };
    case 'claude':
      return {
        invocationId: run,
        message: {
          type: 'result',
          subtype: 'success',
          session_id: session,
          is_error: false,
        },
      };
    case 'opencode':
      return {
        type: 'message.updated',
        properties: {
          info: {
            id: run,
            sessionID: session,
            role: 'assistant',
            time: { created: 1, completed: 2 },
            finish: 'stop',
          },
        },
      };
  }
}
export function runOfflineRoster(
  kinds: ProviderKind[] = ['codex', 'claude', 'opencode'],
) {
  const registry = new ProviderRegistry();
  const counts = { codex: 2, claude: 3, opencode: 5 };
  const results: {
    workerId: string;
    runtimeKind: ProviderKind;
    nativeSessionId: string;
    nativeRunId: string;
    outcome: string;
    liveEnabled: false;
  }[] = [];
  for (const runtimeKind of kinds)
    for (let n = 1; n <= counts[runtimeKind]; n++) {
      const workerId = `${runtimeKind}_${n}`;
      const nativeSessionId = `fixture/${runtimeKind}/session:${n}`;
      const nativeRunId = `fixture/${runtimeKind}/run:${n}`;
      registry.register({
        id: workerId,
        alias: `${runtimeKind}-${n}`,
        hostId: 'fixture',
        endpointId: 'fixture',
        runtimeKind,
        nativeSessionId,
        runtimeVersion: 'unqualified-fixture',
        adapterVersion: '1',
        mode: 'managed',
        quotaGroupId: 'fixture_account',
      });
      const binding = {
        taskId: `task_${workerId}`,
        attemptId: `attempt_${workerId}`,
        generation: 1,
        nativeRunId,
      };
      registry.begin(workerId, binding);
      const outcome = normalizeFixture(
        runtimeKind,
        fixtureFor(runtimeKind, nativeSessionId, nativeRunId),
        nativeSessionId,
        nativeRunId,
      );
      registry.receive(workerId, {
        ...binding,
        workerId,
        runtimeKind,
        nativeSessionId,
        sequence: 1,
        ...outcome,
      });
      registry.reconcile(workerId, binding, 'stopped');
      results.push({
        workerId,
        runtimeKind,
        nativeSessionId,
        nativeRunId,
        outcome: outcome.kind,
        liveEnabled: false,
      });
    }
  return { classification: 'offline', liveProvidersTested: [], results };
}
