import type { Store } from '../../../storage/src/store.ts';
import type { ProviderConnection } from '../../../storage/src/providers.ts';
import { RpcChannel } from './transport.ts';
import type { ChannelOptions } from './transport.ts';
import { CODEX_VERSION } from './profile.ts';

/** Host-driven offline channel. The writer must target an owned synthetic peer. */
export function durableCodexChannel(
  store: Store,
  connection: ProviderConnection,
  options: Pick<ChannelOptions, 'write' | 'onMessage' | 'timeoutMs'>,
): RpcChannel {
  // Use stored identity, not caller-supplied worker metadata.
  const saved = store.providers.get(connection.connectionId);
  if (
    saved.worker.runtimeKind !== 'codex' ||
    saved.worker.runtimeVersion !== CODEX_VERSION
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
      store.providers.recordMessage(id, token, message);
    },
    onClose: () => {
      store.providers.unknown(id, token);
    },
  });
}
