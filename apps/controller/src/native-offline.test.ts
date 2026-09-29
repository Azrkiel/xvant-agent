import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import {
  versions,
  type StreamKind,
} from '../../../packages/adapters/src/providers/native-profiles.ts';
import { OfflineNativeController } from './native-offline.ts';

let root: string, store: Store, controller: OfflineNativeController;
let fault: (point: string) => void;
const spec = (kind: StreamKind) => ({
  connectionId: 'connection',
  taskId: 'task',
  attemptId: 'attempt-custom',
  workspaceId: 'workspace',
  expectedVersion: 1,
  classification: 'offline' as const,
  worker: {
    id: 'worker',
    alias: 'worker',
    runtimeKind: kind,
    hostId: 'host',
    endpointId: 'fixture',
    nativeSessionId: 'custom-session',
    runtimeVersion: versions[kind],
    adapterVersion: 'v1',
    mode: 'managed' as const,
    quotaGroupId: 'account',
  },
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-native-controller-'));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'result.txt'), 'fixture');
  fault = () => {};
  store = new Store(join(root, 'state.sqlite'), {
    owner: 'controller',
    fault: (point) => fault(point),
  });
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Read fixture',
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Pass'],
  });
  store.queue('queue', 'task', 0);
  controller = new OfflineNativeController(
    store,
    new ArtifactStore(join(root, 'objects')),
    { workspace },
    { test: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } },
    { timeoutMs: 2000, fault: (point) => fault(point) },
  );
});
afterEach(() => {
  controller?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true });
});
for (const kind of ['claude', 'opencode'] as const) {
  it(`${kind}: performs setup before fixture dispatch`, async () => {
    expect((await controller.run(spec(kind))).state).toBe(
      'ready_for_acceptance',
    );
    const outgoing = store.providers
      .entries('connection')
      .filter((entry) => entry.direction === 'out');
    expect(outgoing.map((entry) => entry.method)).toEqual([
      'fixture/setup',
      'fixture/start',
    ]);
  });
  it.each(['interrupt', 'interrupt-result-first'])(
    `${kind}: confirms %s without verifying or accepting`,
    async (scenario) => {
      expect((await controller.run(spec(kind), scenario)).state).toBe(
        'needs_attention',
      );
      expect(store.providers.get('connection').outcome).toBe('cancelled');
      expect(store.providers.get('connection').verification).toBeUndefined();
      expect(store.providers.occupied('workspace:workspace')).toBe(true);
      expect(controller.activeCount).toBe(0);
    },
  );
  it.each([
    'setup-error',
    'setup-mismatch',
    'setup-timeout',
    'interrupt-error',
    'interrupt-mismatch',
    'interrupt-timeout',
    'interrupt-partial',
    'interrupt-ack-only',
  ])(`${kind}: fails closed after %s`, async (scenario) => {
    expect((await controller.run(spec(kind), scenario)).state).toBe(
      'needs_attention',
    );
    expect(store.providers.get('connection').status).toBe('unknown');
    expect(store.providers.get('connection').outcome).toBeNull();
    expect(store.providers.get('connection').verification).toBeUndefined();
    expect(controller.activeCount).toBe(0);
    const sent = store.providers
      .entries('connection')
      .filter((entry) => entry.direction === 'out');
    expect(
      sent.filter((entry) => entry.method === 'fixture/start'),
    ).toHaveLength(scenario.startsWith('setup') ? 0 : 1);
  });
  it(`${kind}: does not dispatch after stop at the setup boundary`, async () => {
    fault = (point) => {
      if (point === 'native.after_setup') controller.stop();
    };
    expect((await controller.run(spec(kind))).state).toBe('needs_attention');
    expect(
      store.providers
        .entries('connection')
        .filter((entry) => entry.method === 'fixture/start'),
    ).toHaveLength(0);
    expect(controller.activeCount).toBe(0);
  });
  it.each(['success', 'permission'])(
    `${kind}: journals %s through shutdown and review without acceptance`,
    async (scenario) => {
      expect((await controller.run(spec(kind), scenario)).state).toBe(
        'ready_for_acceptance',
      );
      const saved = store.providers.get('connection');
      expect(saved.verification?.status).toBe('passed');
      expect(saved.worker.nativeSessionId).toBe('custom-session');
      expect(saved.nativeRunId).toBe(
        kind === 'claude' ? 'result-1' : 'assistant-1',
      );
      const entries = store.providers.entries('connection');
      expect(entries.filter((entry) => entry.direction === 'out')).toHaveLength(
        scenario === 'permission' ? 3 : 2,
      );
      expect(entries.filter((entry) => entry.direction === 'in')).toHaveLength(
        (scenario === 'permission' ? 3 : 2) + (kind === 'claude' ? 1 : 0),
      );
      expect(entries[0]?.method).toBe('fixture/setup');
      if (scenario === 'permission') {
        const denial = entries.findIndex(
          (entry) => entry.method === 'fixture/permission-denial',
        );
        expect(entries[denial - 1]?.direction).toBe('in');
        expect(entries[denial]?.frame).toContain(
          kind === 'claude' ? 'deny' : 'reject',
        );
      }
      expect(controller.activeCount).toBe(0);
      expect(
        store.events(0).some((event) => event.kind === 'native.accepted'),
      ).toBe(false);
      await expect(controller.run(spec(kind))).rejects.toThrow(
        'DUPLICATE_IDENTITY',
      );
    },
  );
  it.each(['wrong-session', 'malformed', 'partial', 'error', 'timeout'])(
    `${kind}: retains reservations after %s`,
    async (scenario) => {
      expect((await controller.run(spec(kind), scenario)).state).toBe(
        'needs_attention',
      );
      expect(store.providers.get('connection').verification).toBeUndefined();
      expect(store.providers.occupied('workspace:workspace')).toBe(true);
      expect(controller.activeCount).toBe(0);
      if (!(kind === 'claude' && scenario === 'error')) {
        expect(store.providers.get('connection').status).toBe('unknown');
        expect(store.providers.get('connection').outcome).toBeNull();
      }
    },
  );
  it.each([
    'provider.send.before_commit',
    'provider.receive.before_commit',
    'native.after_shutdown',
  ])(`${kind}: fails closed at %s`, async (point) => {
    fault = (current) => {
      if (current === point) throw new Error('DISK_FAILURE');
    };
    expect((await controller.run(spec(kind), 'permission')).state).toBe(
      'needs_attention',
    );
    expect(store.providers.get('connection').status).toBe('unknown');
    expect(store.providers.get('connection').verification).toBeUndefined();
    const entries = store.providers.entries('connection');
    if (point === 'provider.send.before_commit')
      expect(entries).toHaveLength(0);
    if (point === 'provider.receive.before_commit') {
      expect(entries).toHaveLength(1);
      expect(entries[0]?.method).toBe('fixture/setup');
    }
    expect(controller.activeCount).toBe(0);
  });
  it(`${kind}: stops an in-flight peer without verification`, async () => {
    const pending = controller.run(spec(kind), 'timeout');
    controller.stop();
    expect((await pending).state).toBe('needs_attention');
    expect(controller.activeCount).toBe(0);
    expect(store.providers.get('connection').status).toBe('unknown');
  });
  it(`${kind}: refuses result persistence after controller takeover`, async () => {
    let recovery: Store | undefined;
    fault = (point) => {
      if (point === 'native.after_shutdown') {
        recovery = new Store(join(root, 'state.sqlite'), {
          owner: 'recovery',
          now: () => Date.now() + 120000,
        });
        recovery.recover();
      }
    };
    try {
      expect((await controller.run(spec(kind))).state).toBe('needs_attention');
      expect(store.providers.get('connection').status).toBe('unknown');
      expect(store.providers.get('connection').outcome).toBeNull();
      expect(store.providers.get('connection').verification).toBeUndefined();
      expect(controller.activeCount).toBe(0);
    } finally {
      recovery?.close();
    }
  });
  it(`${kind}: preserves verified evidence when stopped before review`, async () => {
    fault = (point) => {
      if (point === 'native.before_review') controller.stop();
    };
    expect((await controller.run(spec(kind))).state).toBe('needs_attention');
    expect(store.providers.get('connection').status).toBe('verified');
    expect(store.providers.occupied('workspace:workspace')).toBe(true);
  });
}
it('does not dispatch when stopped after reservation', async () => {
  fault = (point) => {
    if (point === 'native.after_reserve') controller.stop();
  };
  expect((await controller.run(spec('claude'))).state).toBe('needs_attention');
  expect(store.providers.entries('connection')).toHaveLength(0);
  expect(controller.activeCount).toBe(0);
});
it('does not prepare review when registered verification fails', async () => {
  controller.stop();
  controller = new OfflineNativeController(
    store,
    new ArtifactStore(join(root, 'objects')),
    { workspace: join(root, 'work') },
    { test: { executable: process.execPath, args: ['-e', 'process.exit(1)'] } },
  );
  expect((await controller.run(spec('opencode'))).state).toBe(
    'needs_attention',
  );
  expect(store.providers.get('connection').status).toBe('verification_failed');
  expect(store.providers.occupied('workspace:workspace')).toBe(true);
});
it('rejects invalid admission before reservation', async () => {
  await expect(controller.run(spec('claude'), 'live')).rejects.toThrow();
  await expect(
    controller.run({
      ...spec('claude'),
      worker: { ...spec('claude').worker, runtimeVersion: 'other' },
    }),
  ).rejects.toThrow('VERSION_UNSUPPORTED');
  await expect(
    controller.run({ ...spec('claude'), workspaceId: 'missing' }),
  ).rejects.toThrow('WORKSPACE_UNAVAILABLE');
  expect(store.getTask('task').state).toBe('queued');
  controller.stop();
  await expect(controller.run(spec('claude'))).rejects.toThrow(
    'CONTROLLER_STOPPED',
  );
});
