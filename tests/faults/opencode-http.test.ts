import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';

const reachable = (origin: string) =>
  new Promise<boolean>((resolve) => {
    const probe = request(
      origin + '/global/health',
      { timeout: 500 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    probe.on('error', () => resolve(false));
    probe.on('timeout', () => probe.destroy());
    probe.end();
  });
it.each([
  'opencode.before_launch',
  'provider.endpoint.before_commit',
  'opencode.after_endpoint',
  'opencode.after_setup',
  'opencode.after_interrupt_request',
  'provider.result.before_commit',
])(
  'recovers HTTP controller death at %s without replay, secrets or orphans',
  async (point) => {
    const root = mkdtempSync(join(tmpdir(), 'xvant-opencode-http-crash-'));
    let store: Store | undefined;
    try {
      const child = spawnSync(
        process.execPath,
        ['tests/faults/opencode-http-worker.ts', root, point],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      expect(child.status, child.stderr).toBe(71);
      store = new Store(join(root, 'state.sqlite'), {
        owner: 'recovery',
        now: () => 3000,
      });
      expect(store.integrity()).toBe('ok');
      expect(store.recover()).toEqual(['attempt']);
      const connection = store.providers.get('connection');
      expect(connection.status).toBe('unknown');
      expect(store.providers.occupied('workspace:workspace')).toBe(true);
      const bound = ![
        'opencode.before_launch',
        'provider.endpoint.before_commit',
      ].includes(point);
      expect(connection.endpoint !== undefined).toBe(bound);
      const methods = store.providers
        .entries('connection')
        .filter((entry) => entry.direction === 'out')
        .map((entry) => entry.method);
      expect(methods[0]).toBe('opencode/serve');
      expect(
        methods.filter((method) => method === 'session/prompt'),
      ).toHaveLength(
        [
          'opencode.after_interrupt_request',
          'provider.result.before_commit',
        ].includes(point)
          ? 1
          : 0,
      );
      expect(connection.interrupt !== undefined).toBe(
        point === 'opencode.after_interrupt_request',
      );
      expect(JSON.stringify(store.providers.entries('connection'))).not.toMatch(
        /basic /i,
      );
      if (connection.endpoint) {
        // The owned server exits when its owner's stdin pipe closes.
        let alive = true;
        for (let tries = 0; alive && tries < 40; tries++) {
          alive = await reachable(connection.endpoint.origin);
          if (alive) await new Promise((done) => setTimeout(done, 50));
        }
        expect(alive).toBe(false);
      }
      expect(() =>
        store!.queue('retry', 'task', store!.getTask('task').rowVersion),
      ).toThrow('UNRESOLVED_OPERATION');
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
