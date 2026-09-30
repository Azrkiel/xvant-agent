import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';

it.each([
  'live.after_reserve',
  'provider.send.before_commit',
  'live.after_session',
  'provider.session.before_commit',
  'live.after_intent',
  'live.after_launch',
  'provider.receive.before_commit',
  'live.after_shutdown',
  'provider.result.before_commit',
  'provider.verify.before_commit',
  'provider.verified.before_commit',
  'native.prepare.before_commit',
])(
  'recovers live CLI controller death at %s without replay or acceptance',
  (point) => {
    const root = mkdtempSync(join(tmpdir(), 'xvant-live-crash-'));
    let store: Store | undefined;
    try {
      const child = spawnSync(
        process.execPath,
        ['tests/faults/opencode-live-worker.ts', root, point],
        {
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        },
      );
      expect(child.status, child.stderr).toBe(71);
      store = new Store(join(root, 'state.sqlite'), {
        owner: 'recovery',
        now: () => 3000,
      });
      const verified = point === 'native.prepare.before_commit';
      const pending = point === 'provider.verify.before_commit';
      expect(store.integrity()).toBe('ok');
      expect(store.recover()).toEqual(verified || pending ? [] : ['attempt']);
      expect(store.recover()).toEqual([]);
      const connection = store.providers.get('connection');
      expect(connection).toMatchObject({
        status: verified ? 'verified' : pending ? 'result_pending' : 'unknown',
        classification: 'live',
        liveApproval: {
          actorId: 'operator',
          model: 'opencode/big-pickle',
          transport: 'cli',
          userApprovedTrustedLocal: true,
        },
        outcome:
          verified || pending || point === 'provider.verified.before_commit'
            ? 'completed'
            : null,
      });
      expect(connection.worker.nativeSessionId).toMatch(
        [
          'live.after_reserve',
          'provider.send.before_commit',
          'provider.receive.before_commit',
          'provider.session.before_commit',
        ].includes(point)
          ? /^pending:connection$/
          : /^ses_[a-f0-9]{32}$/,
      );
      expect(connection.worker.nativeSessionId).not.toBe('ses_Provisional');
      expect(store.getTask('task').state).toBe('needs_attention');
      for (const resource of [
        'workspace:workspace',
        'worker:worker',
        'native:' +
          JSON.stringify([
            'opencode',
            'host',
            connection.worker.nativeSessionId,
          ]),
      ])
        expect(store.providers.occupied(resource)).toBe(true);
      const entries = store.providers.entries('connection');
      expect(
        entries.filter(
          (entry) =>
            entry.direction === 'out' && entry.method === 'opencode/cli-run',
        ),
      ).toHaveLength(
        [
          'live.after_reserve',
          'provider.send.before_commit',
          'provider.receive.before_commit',
          'provider.session.before_commit',
          'live.after_session',
        ].includes(point)
          ? 0
          : 1,
      );
      expect(() =>
        store!.providers.recordIntent('connection', connection.token, {
          id: 2,
          method: 'opencode/cli-run',
          frame: '{}\n',
        }),
      ).toThrow('STALE_FENCE');
      expect(() =>
        store!.queue('retry', 'task', store!.getTask('task').rowVersion),
      ).toThrow('UNRESOLVED_OPERATION');
      expect(store.providers.entries('connection')).toEqual(entries);
      expect(
        store.events(0).some((event) => event.kind === 'native.accepted'),
      ).toBe(false);
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
