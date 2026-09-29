import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';

it.each([
  'native.after_reserve',
  'provider.session.before_commit',
  'native.after_session',
  'native.after_setup',
])(
  'recovers OpenCode creation death at %s without dispatch or recreation',
  (point) => {
    const root = mkdtempSync(join(tmpdir(), 'xvant-native-session-crash-'));
    let store: Store | undefined;
    try {
      const child = spawnSync(
        process.execPath,
        [
          'tests/faults/native-controller-worker.ts',
          root,
          point,
          'opencode',
          'create',
        ],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      expect(child.status, child.stderr).toBe(71);
      store = new Store(join(root, 'state.sqlite'), {
        owner: 'recovery',
        now: () => 3000,
      });
      expect(store.integrity()).toBe('ok');
      expect(store.recover()).toEqual(['attempt']);
      const bound = ['native.after_session', 'native.after_setup'].includes(
        point,
      );
      const session = bound ? 'created-1' : 'pending:connection';
      expect(store.providers.get('connection')).toMatchObject({
        status: 'unknown',
        worker: { nativeSessionId: session },
      });
      expect(
        store.providers.occupied(
          'native:' + JSON.stringify(['opencode', 'host', session]),
        ),
      ).toBe(true);
      expect(
        store.providers.occupied(
          'native:' +
            JSON.stringify([
              'opencode',
              'host',
              bound ? 'pending:connection' : 'created-1',
            ]),
        ),
      ).toBe(false);
      const entries = store.providers.entries('connection');
      expect(
        entries.filter((entry) => entry.method === 'session/create'),
      ).toHaveLength(point === 'native.after_reserve' ? 0 : 1);
      expect(
        entries.filter((entry) => entry.method === 'fixture/start'),
      ).toHaveLength(0);
      expect(store.providers.get('connection').verification).toBeUndefined();
      expect(store.getTask('task').state).toBe('needs_attention');
      expect(() =>
        store!.queue('retry', 'task', store!.getTask('task').rowVersion),
      ).toThrow('UNRESOLVED_OPERATION');
      expect(store.recover()).toEqual([]);
      expect(store.providers.entries('connection')).toEqual(entries);
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
