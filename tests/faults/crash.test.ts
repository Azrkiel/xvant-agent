import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../packages/storage/src/store.ts';
import Database from 'better-sqlite3';
it.each([
  'create.before_commit',
  'dispatch.before_commit',
  'after_dispatch',
  'send.before_commit',
  'after_send',
  'after_ack',
  'after_result',
])('survives process death at %s without replay', (point) => {
  const root = mkdtempSync(join(tmpdir(), 'xvant-crash-'));
  const path = join(root, 'db.sqlite');
  let store: Store | undefined;
  try {
    const run = spawnSync(
      process.execPath,
      ['tests/faults/crash-worker.ts', path, point],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    );
    expect(run.status, run.stderr).toBe(71);
    store = new Store(path, {
      owner: 'recovery',
      now: () => 2000,
      leaseMs: 500,
    });
    expect(store.integrity()).toBe('ok');
    store.recover();
    const db = new Database(path, { readonly: true });
    try {
      if (point === 'create.before_commit') {
        expect(() => store!.getTask('task')).toThrow('NOT_FOUND');
        expect(db.prepare('select count(*) n from commands').get()).toEqual({
          n: 0,
        });
      } else if (point === 'dispatch.before_commit') {
        expect(store.getTask('task').state).toBe('queued');
        expect(() => store!.getOperation('attempt')).toThrow('NOT_FOUND');
        expect(db.prepare('select count(*) n from outbox').get()).toEqual({
          n: 0,
        });
      } else {
        expect(store.getTask('task').state).toBe('needs_attention');
        expect(store.getOperation('attempt').reason).toBe(
          point === 'after_result' ? 'verifier_failed' : 'unknown',
        );
        if (point !== 'after_result')
          expect(() =>
            store!.queue('retry', 'task', store!.getTask('task').rowVersion),
          ).toThrow();
        expect(store.recover()).toEqual([]);
      }
    } finally {
      db.close();
    }
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
