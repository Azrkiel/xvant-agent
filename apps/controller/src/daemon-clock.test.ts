import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { Store } from '../../../packages/storage/src/store.ts';
import { DaemonClock } from './daemon-clock.ts';

it('keeps an absolute high-water clock and a boot-relative lease through jumps and simulated suspend', () => {
  const root = mkdtempSync(join(tmpdir(), 'xvant-clock-'));
  let boot = 'boot-a';
  let wall = 1_000_000;
  let uptime = 1_000;
  const host = () => ({ boot, uptime });
  const clock = new DaemonClock(host, () => wall);
  const open = (owner: string, clock: DaemonClock) =>
    new Store(join(root, 'state.sqlite'), {
      owner,
      now: clock.now,
      leaseClock: host,
      leaseMs: 900,
    });
  const first = open('first', clock);
  let second: Store | undefined;
  try {
    const schedule = first.schedule;
    first.graphs.create('root', 'project', {}, {});
    schedule.add({
      id: 'root',
      project: 'project',
      resources: ['worker:a'],
      priority: 2,
      dueAt: wall + 200,
      slots: 1,
    });
    const deadline = wall + 500;
    wall -= 20_000;
    uptime += 100;
    expect(clock.now()).toBe(1_000_100);
    expect(schedule.claim(1, () => undefined)).toBeUndefined();
    expect(() => open('other', new DaemonClock(host, () => wall))).toThrow(
      'LEASE_BUSY',
    );
    wall += 40_000;
    uptime += 10;
    const claimed = schedule.claim(1, () => undefined)!;
    expect(claimed).toMatchObject({ status: 'running' });
    expect(clock.now()).toBeGreaterThan(deadline);
    first.heartbeat(clock.sample());
    wall -= 50_000;
    uptime += 5_000;
    const restored = new DaemonClock(host, () => wall);
    second = open('next', restored);
    restored.restore(second.schedule.clock());
    expect(restored.now()).toBe(1_025_000);
    second.schedule.takeover();
    const blocked = () => ({ reason: 'RECONCILIATION_REQUIRED' });
    expect(second.schedule.claim(1, blocked)).toBeUndefined();
    expect(second.schedule.get('root')).toMatchObject({
      status: 'queued',
      reason: 'RECONCILIATION_REQUIRED',
      acceptedAt: 1_000_000,
    });
    expect(() => first.daemonCommand('old-command', {}, () => ({}))).toThrow(
      'STALE_FENCE',
    );
    expect(() =>
      first.schedule.settle('root', 'done', null, claimed.claim!),
    ).toThrow('STALE_FENCE');
    second.heartbeat(restored.sample());
    boot = 'boot-b';
    uptime = 50;
    const rebooted = new DaemonClock(host, () => wall);
    rebooted.restore(second.schedule.clock());
    expect(rebooted.now()).toBe(1_025_000);
  } finally {
    first.close();
    second?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('orders eligible projects fairly and enforces resource limits independently of due time and priority', () => {
  const root = mkdtempSync(join(tmpdir(), 'xvant-schedule-'));
  let now = 100;
  const store = new Store(join(root, 'state.sqlite'), {
    owner: 'fixture',
    now: () => now,
  });
  try {
    const schedule = store.schedule;
    function add(
      id: string,
      project: string,
      resource: string,
      priority: number,
      dueAt = now,
    ) {
      store.graphs.create(id, project, {}, {});
      schedule.add({
        id,
        project,
        resources: [resource],
        priority,
        dueAt,
        slots: 1,
      });
    }
    add('first', 'busy', 'worker:a', 10);
    add('second', 'busy', 'worker:a', 9);
    add('blocked', 'blocked', 'worker:a', 1);
    add('due', 'independent', 'worker:b', 0, 300);
    const claim = (slots = 2) => schedule.claim(slots, () => undefined);
    const first = claim()!;
    expect(first.id).toBe('first');
    expect(claim()).toBeUndefined();
    expect(schedule.get('blocked')?.reason).toBe('RESOURCE_IN_USE');
    expect(schedule.wakeAt(now)).toBe(300);
    now = 300;
    expect(claim(1)).toBeUndefined();
    expect(schedule.get('due')?.reason).toBe('WORKER_LIMIT');
    expect(claim()?.id).toBe('due');
    schedule.settle('first', 'done', null, first.claim!);
    expect(claim()?.id).toBe('blocked');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
