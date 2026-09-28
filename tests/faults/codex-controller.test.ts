import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';

it.each([
  'codex.after_reserve',
  'codex.after_shutdown',
  'provider.result.before_commit',
  'codex.before_review',
  'native.prepare.before_commit',
])(
  'recovers controller death at %s without replay or acceptance',
  (point) => {
    const root = mkdtempSync(join(tmpdir(), 'xvant-controller-crash-'));
    let store: Store | undefined;
    try {
      const child = spawnSync(
        process.execPath,
        ['tests/faults/codex-controller-worker.ts', root, point],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      expect(child.status, child.stderr).toBe(71);
      store = new Store(join(root, 'state.sqlite'), {
        owner: 'recovery',
        now: () => 3000,
      });
      const verified = [
        'codex.before_review',
        'native.prepare.before_commit',
      ].includes(point);
      expect(store.integrity()).toBe('ok');
      expect(store.recover()).toEqual(verified ? [] : ['attempt']);
      expect(store.recover()).toEqual([]);
      expect(store.providers.get('connection').status).toBe(
        verified ? 'verified' : 'unknown',
      );
      expect(store.getTask('task').state).toBe('needs_attention');
      expect(store.providers.occupied('workspace:workspace')).toBe(true);
      const entries = store.providers.entries('connection');
      expect(
        entries.filter(
          (entry) => entry.direction === 'out' && entry.method === 'turn/start',
        ),
      ).toHaveLength(point === 'codex.after_reserve' ? 0 : 1);
      expect(
        store.events(0).some((event) => event.kind === 'native.accepted'),
      ).toBe(false);
      expect(() =>
        store!.queue('retry', 'task', store!.getTask('task').rowVersion),
      ).toThrow('UNRESOLVED_OPERATION');
      expect(store.providers.entries('connection')).toEqual(entries);
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
