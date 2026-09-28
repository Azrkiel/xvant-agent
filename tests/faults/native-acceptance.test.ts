import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';
it.each([
  'native.prepare.before_commit',
  'native.accept.before_commit',
  'after_accepted',
])(
  'atomically survives native acceptance crash at %s',
  (point) => {
    const root = mkdtempSync(join(tmpdir(), 'xvant-accept-crash-'));
    let store: Store | undefined;
    try {
      const child = spawnSync(
        process.execPath,
        ['tests/faults/native-verification-worker.ts', root, point],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      expect(child.status, child.stderr).toBe(71);
      store = new Store(join(root, 'state.sqlite'), {
        owner: 'recovery',
        now: () => 3000,
      });
      expect(store.integrity()).toBe('ok');
      expect(store.recover()).toEqual([]);
      expect(store.getTask('task').state).toBe(
        point === 'after_accepted'
          ? 'accepted'
          : point === 'native.accept.before_commit'
            ? 'ready_for_acceptance'
            : 'needs_attention',
      );
      expect(store.providers.occupied('workspace:workspace')).toBe(
        point !== 'after_accepted',
      );
      expect(
        store.events(0).filter((event) => event.kind === 'native.accepted'),
      ).toHaveLength(point === 'after_accepted' ? 1 : 0);
      if (point === 'after_accepted')
        expect(store.getTask('task').nativeQualification?.classification).toBe(
          'offline',
        );
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
