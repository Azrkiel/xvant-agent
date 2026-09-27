import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { parse, runRequestSchema } from '../../../contracts/src/index.ts';
import type {
  RuntimeAdapter,
  RunRequest,
} from '../../../contracts/src/index.ts';

export class SimulatedAdapter implements RuntimeAdapter {
  readonly runtimeKind = 'simulated' as const;
  private readonly delay: (signal?: AbortSignal) => Promise<void>;
  constructor(
    delay: (signal?: AbortSignal) => Promise<void> = async (signal) => {
      await wait(25, undefined, { signal });
    },
  ) {
    this.delay = delay;
  }
  async *run(input: RunRequest, signal?: AbortSignal): AsyncIterable<unknown> {
    const request = parse(runRequestSchema, input);
    let sequence = 0;
    const base = () => ({
      schemaVersion: 1,
      sequence: ++sequence,
      taskId: request.taskId,
      attemptId: request.attemptId,
      workerId: request.workerId,
      runtimeKind: 'simulated',
      simulated: true,
    });
    if (signal?.aborted) {
      yield { ...base(), kind: 'cancelled' };
      return;
    }
    yield { ...base(), kind: 'started' };
    if (request.scenario === 'delayed') {
      try {
        await this.delay(signal);
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
    }
    if (signal?.aborted) {
      yield { ...base(), kind: 'cancelled' };
      return;
    }
    switch (request.scenario) {
      case 'failure':
        yield { ...base(), kind: 'failed', reason: 'SIMULATED_FAILURE' };
        return;
      case 'quota':
        yield { ...base(), kind: 'quota' };
        return;
      case 'unknown':
        yield { ...base(), kind: 'unknown' };
        return;
      case 'malformed':
        yield { ...base(), kind: 'completed', simulated: false };
        return;
    }
    const text = '[SIMULATED] Completed fixture task ' + request.taskId;
    yield { ...base(), kind: 'output', text };
    if (signal?.aborted) {
      yield { ...base(), kind: 'cancelled' };
      return;
    }
    const treeHash = createHash('sha256')
      .update('SIMULATED_TREE:' + request.taskId)
      .digest('hex');
    const artifactSetHash = createHash('sha256').update(text).digest('hex');
    yield { ...base(), kind: 'completed', treeHash, artifactSetHash };
  }
}
