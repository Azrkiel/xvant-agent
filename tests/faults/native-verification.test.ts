import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../packages/storage/src/artifacts.ts';
it.each([
  'provider.verify.before_commit',
  'provider.verified.before_commit',
  'after_verified',
  'success',
])(
  'preserves native verification across process boundary %s',
  (point) => {
    const root = mkdtempSync(join(tmpdir(), 'xvant-verify-crash-'));
    let store: Store | undefined;
    try {
      const child = spawnSync(
        process.execPath,
        ['tests/faults/native-verification-worker.ts', root, point],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      expect(child.status, child.stderr).toBe(point === 'success' ? 0 : 71);
      store = new Store(join(root, 'state.sqlite'), {
        owner: 'recover',
        now: () => 3000,
      });
      expect(store.integrity()).toBe('ok');
      expect(store.recover()).toEqual(
        point === 'provider.verified.before_commit' ? ['attempt'] : [],
      );
      const connection = store.providers.get('connection');
      expect(store.providers.occupied('workspace:workspace')).toBe(true);
      if (point === 'after_verified' || point === 'success') {
        expect(connection.status).toBe('verified');
        expect(connection.verification?.status).toBe('passed');
        const objects = new ArtifactStore(join(root, 'objects'));
        for (const hash of store.artifactHashes())
          expect(objects.get(hash)).toBeInstanceOf(Buffer);
        expect(store.artifactHashes().length).toBeGreaterThan(2);
      } else {
        expect(connection.status).toBe(
          point === 'provider.verify.before_commit'
            ? 'result_pending'
            : 'unknown',
        );
        expect(connection.verification).toBeUndefined();
        expect(store.artifactHashes()).toEqual([]);
      }
      expect(store.getTask('task').state).toBe('needs_attention');
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
