import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';

it.each([
  'provider.reserve.before_commit',
  'provider.send.before_commit',
  'before_write',
  'after_write',
  'provider.receive.before_commit',
  'after_ack',
  'provider.result.before_commit',
  'after_result',
])(
  'recovers actual process death at %s without replay',
  async (point) => {
    const root = mkdtempSync(join(tmpdir(), 'xvant-provider-crash-'));
    const path = join(root, 'state.sqlite');
    let store: Store | undefined;
    const child = spawn(
      process.execPath,
      ['tests/faults/provider-worker.ts', path, point],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let diagnostics = '';
    const frames: { method: string; id?: number }[] = [];
    const deadline = setTimeout(() => child.kill(), 8000);
    child.stderr.on('data', (bytes) => {
      diagnostics += bytes.toString();
    });
    child.stdin.on('error', () => {}); // The injected crash can race the fixture's reply.
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const frame = JSON.parse(line);
      frames.push(frame);
      if (frame.method === 'turn/start')
        child.stdin.write(
          JSON.stringify({ id: frame.id, result: { turn: { id: 'turn-1' } } }) +
            '\n',
        );
      else if (frame.method === 'fixture/ready')
        child.stdin.write(
          '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}\n',
        );
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      });
      expect(code, diagnostics).toBe(71);
      store = new Store(path, {
        owner: 'recovery',
        now: () => 2000,
        leaseMs: 500,
      });
      expect(store.integrity()).toBe('ok');
      const noConnection = point === 'provider.reserve.before_commit';
      expect(store.recover()).toEqual(
        noConnection || point === 'after_result' ? [] : ['attempt'],
      );
      expect(store.recover()).toEqual([]);
      expect(
        frames.filter((frame) => frame.method === 'turn/start'),
      ).toHaveLength(
        [
          'provider.reserve.before_commit',
          'provider.send.before_commit',
          'before_write',
        ].includes(point)
          ? 0
          : 1,
      );
      if (noConnection) {
        expect(store.getTask('task').state).toBe('queued');
        expect(() => store!.providers.get('connection')).toThrow('NOT_FOUND');
      } else {
        expect(store.providers.get('connection').status).toBe(
          point === 'after_result' ? 'result_pending' : 'unknown',
        );
        expect(store.getTask('task').state).toBe('needs_attention');
        expect(() =>
          store!.queue('retry', 'task', store!.getTask('task').rowVersion),
        ).toThrow('UNRESOLVED_OPERATION');
        const entries = store.providers.entries('connection');
        expect(
          entries.filter((entry) => entry.direction === 'in'),
        ).toHaveLength(
          ['after_ack'].includes(point)
            ? 1
            : ['provider.result.before_commit', 'after_result'].includes(point)
              ? 2
              : 0,
        );
        store.providers.reconcile('connection', 'stopped');
        expect(
          store.queue('retry', 'task', store.getTask('task').rowVersion).state,
        ).toBe('queued');
      }
    } finally {
      clearTimeout(deadline);
      child.kill();
      lines.close();
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  12000,
);
