import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { verifiedWorkspaceObjects } from '../../../packages/storage/src/workspace.ts';

/** Trusted host review boundary. Does not expose acceptance through provider messages or HTTP. */
export class NativeReviewController {
  private readonly store: Store;
  private readonly objects: ArtifactStore;
  constructor(store: Store, objects: ArtifactStore) {
    this.store = store;
    this.objects = objects;
  }
  prepare(commandId: string, connectionId: string, expectedVersion: number) {
    return this.store.prepareNativeAcceptance(
      commandId,
      connectionId,
      expectedVersion,
      this.objects,
    );
  }
  evidence(connectionId: string) {
    return this.store.providers.acceptanceEvidence(connectionId, true);
  }
  artifact(connectionId: string, hash: string): Buffer {
    const evidence = this.store.providers.acceptanceEvidence(
      connectionId,
      true,
    );
    if (!verifiedWorkspaceObjects(this.objects, evidence).includes(hash))
      throw new Error('NOT_FOUND');
    return this.objects.get(hash);
  }
  accept(commandId: string, input: unknown) {
    return this.store.acceptNative(commandId, input, this.objects);
  }
}
