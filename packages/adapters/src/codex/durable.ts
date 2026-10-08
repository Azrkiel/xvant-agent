import type { Store } from '../../../storage/src/store.ts';
import type { ProviderConnection } from '../../../storage/src/providers.ts';
import { RpcChannel } from './transport.ts';
import type { ChannelOptions } from './transport.ts';
import { codexVersionAccepted } from './profile.ts';

/** Host-driven offline channel. The writer must target an owned synthetic peer. */
export function durableCodexChannel(
  store: Store,
  connection: ProviderConnection,
  options: Pick<
    ChannelOptions,
    'write' | 'onMessage' | 'timeoutMs' | 'maxFrameBytes'
  > & {
    /** Journal only messages that can change state; streamed deltas confer none. */
    journal?: (message: Record<string, unknown>) => boolean;
  },
): RpcChannel {
  // Use stored identity, not caller-supplied worker metadata.
  const saved = store.providers.get(connection.connectionId);
  if (
    saved.worker.runtimeKind !== 'codex' ||
    !codexVersionAccepted(saved.worker.runtimeVersion)
  )
    throw new Error('VERSION_UNSUPPORTED');
  const id = saved.connectionId;
  const token = connection.token;
  return new RpcChannel({
    ...options,
    beforeWrite: async (intent) => {
      store.providers.recordIntent(id, token, intent);
    },
    write: async (frame) => {
      // Recheck after the await at the persistence barrier, immediately before the write.
      store.providers.assertWritable(id, token);
      await options.write(frame);
    },
    beforeReceive: (message) => {
      if (options.journal && !options.journal(message)) {
        store.providers.assertWritable(id, token);
        return;
      }
      store.providers.recordMessage(id, token, message);
    },
    onClose: () => {
      store.providers.unknown(id, token);
    },
  });
}
