import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';

for (const mode of ['create', 'resume']) {
  it.each([
    'native.after_reserve',
    'provider.send.before_commit',
    'native.before_launch',
    'native.after_launch',
  ])(
    `recovers Claude ${mode} crash at %s without launch replay`,
    (point) => {
      const root = mkdtempSync(join(tmpdir(), 'xvant-claude-launch-crash-'));
      let store: Store | undefined;
      try {
        const child = spawnSync(
          process.execPath,
          [
            'tests/faults/native-controller-worker.ts',
            root,
            point,
            'claude',
            mode,
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
        const session =
          mode === 'create'
            ? '6306ed11-5ca4-4c61-a177-5b64eddf5d5b'
            : 'session-1';
        expect(store.providers.get('connection')).toMatchObject({
          status: 'unknown',
          worker: { nativeSessionId: session },
        });
        expect(
          store.providers.occupied(
            'native:' + JSON.stringify(['claude', 'host', session]),
          ),
        ).toBe(true);
        const entries = store.providers.entries('connection');
        expect(entries).toHaveLength(
          ['native.after_reserve', 'provider.send.before_commit'].includes(
            point,
          )
            ? 0
            : 1,
        );
        if (entries.length) {
          expect(entries[0]?.method).toBe('fixture/claude-launch');
          expect(
            JSON.parse(entries[0]!.frame!).options[
              mode === 'create' ? 'sessionId' : 'resume'
            ],
          ).toBe(session);
        }
        expect(store.providers.get('connection').verification).toBeUndefined();
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
}
