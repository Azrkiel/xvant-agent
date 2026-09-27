import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, StorageError } from '../../../packages/storage/src/store.ts';
import {
  parse,
  createTaskSchema,
} from '../../../packages/contracts/src/index.ts';
import { DurableController } from './durable.ts';
import type { ProcessCheck } from './durable.ts';
import type { Dispatch } from '../../../packages/storage/src/store.ts';
import { startLoopbackApi } from './http/server.ts';
/** Trusted host entry point. HTTP clients cannot register commands, paths, or verifiers. */
export async function startService(
  root: string,
  checks: Record<string, ProcessCheck>,
) {
  mkdirSync(root, { recursive: true });
  const store = new Store(join(root, 'state.sqlite'), {
    owner: 'controller_' + randomUUID(),
  });
  let controller: DurableController | undefined;
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  try {
    const activeController = new DurableController(store, checks);
    controller = activeController;
    store.recover();
    const api = await startLoopbackApi({
      events: async (after) => store.events(after),
      command: async (command) => {
        if (closing) throw new StorageError('STALE_FENCE');
        if (command.kind === 'create') {
          const input = parse(createTaskSchema, command.input);
          if (input.requiredCheckIds.some((id) => !Object.hasOwn(checks, id)))
            throw new StorageError('VERIFIER_UNAVAILABLE');
          return store.create(command.commandId, input);
        }
        if (command.kind === 'queue' || command.kind === 'accept') {
          const { expectedVersion } = z
            .strictObject({ expectedVersion: z.number().int().nonnegative() })
            .parse(command.input);
          return command.kind === 'queue'
            ? store.queue(command.commandId, command.taskId, expectedVersion)
            : store.accept(command.commandId, command.taskId, expectedVersion);
        }
        const promise = activeController.run(command.commandId, {
          ...command.input,
          taskId: command.taskId,
        } as Dispatch);
        pending.add(promise);
        try {
          return await promise;
        } finally {
          pending.delete(promise);
        }
      },
    });
    return {
      ...api,
      close: async () => {
        closing = true;
        activeController.stop();
        try {
          await api.close();
        } finally {
          await Promise.allSettled(pending);
          store.close();
        }
      },
    };
  } catch (error) {
    controller?.stop();
    store.close();
    throw error;
  }
}
