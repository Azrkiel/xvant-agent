import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';

for (const kind of ['claude', 'opencode']) {
  it.each([
    'native.after_reserve',
    'native.after_setup',
    'provider.interrupt.before_commit',
    'native.after_interrupt_request',
    'native.after_interrupt',
    'provider.send.before_commit',
    'provider.receive.before_commit',
    'native.after_shutdown',
    'provider.result.before_commit',
    'native.before_review',
    'native.prepare.before_commit',
  ])(
    `${kind}: recovers controller death at %s without replay or acceptance`,
    (point) => {
      const root = mkdtempSync(
        join(tmpdir(), 'xvant-native-controller-crash-'),
      );
      let store: Store | undefined;
      try {
        const child = spawnSync(
          process.execPath,
          ['tests/faults/native-controller-worker.ts', root, point, kind],
          { encoding: 'utf8', timeout: 10000, windowsHide: true },
        );
        expect(child.status, child.stderr).toBe(71);
        store = new Store(join(root, 'state.sqlite'), {
          owner: 'recovery',
          now: () => 3000,
        });
        const verified = [
          'native.before_review',
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
            (entry) =>
              entry.direction === 'out' && entry.method === 'fixture/start',
          ),
        ).toHaveLength(
          [
            'native.after_reserve',
            'provider.send.before_commit',
            'provider.receive.before_commit',
            'native.after_setup',
          ].includes(point)
            ? 0
            : 1,
        );
        const admitted = [
          'native.after_interrupt_request',
          'native.after_interrupt',
        ].includes(point);
        expect(store.providers.get('connection').interrupt).toEqual(
          admitted ? { actorId: 'operator', generation: 1 } : undefined,
        );
        expect(
          store
            .events(0)
            .filter((event) => event.kind === 'provider.interrupt_requested'),
        ).toHaveLength(admitted ? 1 : 0);
        expect(
          entries.filter((entry) => entry.method === 'fixture/interrupt'),
        ).toHaveLength(point === 'native.after_interrupt' ? 1 : 0);
        expect(store.providers.get('connection').outcome).toBe(
          verified ? 'completed' : null,
        );
        if (point === 'provider.receive.before_commit')
          expect(entries).toHaveLength(kind === 'claude' ? 2 : 1);
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
}
for (const kind of ['claude', 'opencode'])
  it.each(['provider.failure.before_commit', 'provider.result.before_commit'])(
    `${kind}: keeps a committed quota block across death at %s`,
    (point) => {
      const root = mkdtempSync(join(tmpdir(), 'xvant-native-failure-crash-'));
      let store: Store | undefined;
      try {
        const child = spawnSync(
          process.execPath,
          [
            'tests/faults/native-controller-worker.ts',
            root,
            point,
            kind,
            'resume',
            'quota-error',
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
        const committed = point === 'provider.result.before_commit';
        expect(store.providers.get('connection')).toMatchObject({
          status: 'unknown',
          outcome: null,
        });
        expect(store.providers.get('connection').failure?.code).toBe(
          committed ? 'QUOTA_BLOCKED' : undefined,
        );
        expect(store.providers.blocked('account')?.code).toBe(
          committed ? 'QUOTA_BLOCKED' : undefined,
        );
      } finally {
        store?.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    15000,
  );
