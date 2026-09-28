import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { CODEX_VERSION } from '../../../packages/adapters/src/codex/profile.ts';
import { OfflineCodexController } from './codex-offline.ts';
const spec = {
  connectionId: 'connection',
  taskId: 'task',
  attemptId: 'attempt',
  workspaceId: 'workspace',
  expectedVersion: 1,
  classification: 'offline' as const,
  worker: {
    id: 'worker',
    alias: 'worker',
    runtimeKind: 'codex' as const,
    hostId: 'host',
    endpointId: 'fixture',
    nativeSessionId: 'thread-1',
    runtimeVersion: CODEX_VERSION,
    adapterVersion: 'v1',
    mode: 'managed' as const,
    quotaGroupId: 'account',
  },
};
let root: string,
  store: Store,
  objects: ArtifactStore,
  controller: OfflineCodexController;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-codex-controller-'));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'result.txt'), 'fixture');
  store = new Store(join(root, 'state.sqlite'), { owner: 'controller' });
  objects = new ArtifactStore(join(root, 'objects'));
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Read fixture',
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Pass'],
  });
  store.queue('queue', 'task', 0);
  controller = new OfflineCodexController(
    store,
    objects,
    { workspace },
    { test: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } },
    { timeoutMs: 2000 },
  );
});
afterEach(() => {
  controller.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
it.each(['success', 'approval'])(
  'orchestrates %s through owned shutdown, verification and review without acceptance',
  async (scenario) => {
    const result = await controller.run(spec, scenario);
    expect(result.state).toBe('ready_for_acceptance');
    expect(result.nativeQualification?.classification).toBe('offline');
    expect(store.providers.get('connection').verification?.status).toBe(
      'passed',
    );
    expect(controller.activeCount).toBe(0);
    const entries = store.providers.entries('connection');
    expect(
      entries.filter(
        (entry) => entry.direction === 'out' && entry.method === 'turn/start',
      ),
    ).toHaveLength(1);
    if (scenario === 'approval')
      expect(entries.some((entry) => entry.frame?.includes('decline'))).toBe(
        true,
      );
    expect(
      store.events(0).some((event) => event.kind === 'native.accepted'),
    ).toBe(false);
    await expect(controller.run(spec, scenario)).rejects.toThrow(
      'DUPLICATE_IDENTITY',
    );
  },
);
it.each(['interrupt', 'disconnect', 'malformed', 'timeout', 'late-malformed'])(
  'retains reservations after %s without verifying or resending',
  async (scenario) => {
    const result = await controller.run(spec, scenario);
    expect(result.state).toBe('needs_attention');
    expect(store.providers.get('connection').verification).toBeUndefined();
    expect(store.providers.occupied('workspace:workspace')).toBe(true);
    expect(controller.activeCount).toBe(0);
    expect(
      store.providers
        .entries('connection')
        .filter(
          (entry) => entry.direction === 'out' && entry.method === 'turn/start',
        ),
    ).toHaveLength(1);
  },
);
it('refuses admission after stop', async () => {
  controller.stop();
  await expect(controller.run(spec)).rejects.toThrow('CONTROLLER_STOPPED');
  expect(store.getTask('task').state).toBe('queued');
});
it('does not dispatch a turn when stopped immediately after session setup', async () => {
  controller.stop();
  controller = new OfflineCodexController(
    store,
    objects,
    { workspace: join(root, 'work') },
    { test: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } },
    {
      fault: (point) => {
        if (point === 'codex.after_session') controller.stop();
      },
    },
  );
  expect((await controller.run(spec)).state).toBe('needs_attention');
  expect(
    store.providers
      .entries('connection')
      .filter(
        (entry) => entry.direction === 'out' && entry.method === 'turn/start',
      ),
  ).toHaveLength(0);
});
it('rejects incomplete trailing output before persisting a successful outcome', async () => {
  const result = await controller.run(spec, 'late-partial');
  expect(result.state).toBe('needs_attention');
  expect(store.providers.get('connection')).toMatchObject({
    status: 'unknown',
  });
  expect(store.providers.get('connection').outcome).toBeNull();
  expect(store.providers.get('connection').verification).toBeUndefined();
  expect(store.providers.occupied('workspace:workspace')).toBe(true);
});
it('stops an in-flight peer without verification or replay', async () => {
  const result = controller.run(spec, 'timeout');
  controller.stop();
  expect((await result).state).toBe('needs_attention');
  expect(controller.activeCount).toBe(0);
  expect(store.providers.get('connection').status).toBe('unknown');
  expect(store.providers.get('connection').verification).toBeUndefined();
  expect(store.providers.occupied('workspace:workspace')).toBe(true);
});
it('rejects invalid scenarios and unpinned workers before reserving', async () => {
  await expect(controller.run(spec, 'live')).rejects.toThrow();
  await expect(
    controller.run({
      ...spec,
      worker: { ...spec.worker, runtimeVersion: 'other' },
    }),
  ).rejects.toThrow('VERSION_UNSUPPORTED');
  expect(store.getTask('task').state).toBe('queued');
});
it('keeps connection identity separate from existing command identities', async () => {
  const result = await controller.run({ ...spec, connectionId: 'create' });
  expect(result.state).toBe('ready_for_acceptance');
});
it.each(['create', 'resume'] as const)(
  'performs explicit %s before turn dispatch and binds evidence to the returned session',
  async (mode) => {
    const result = await controller.run(spec, 'success', mode);
    expect(result.state).toBe('ready_for_acceptance');
    const saved = store.providers.get('connection');
    expect(saved.worker.nativeSessionId).toBe(
      mode === 'create' ? 'created-1' : 'thread-1',
    );
    expect(saved.verification?.status).toBe('passed');
    if (saved.verification?.status !== 'passed')
      throw new Error('Expected passed verification');
    expect(saved.verification.evidence.nativeSessionId).toBe(
      saved.worker.nativeSessionId,
    );
    const requests = store.providers
      .entries('connection')
      .filter((entry) => entry.direction === 'out')
      .map((entry) => entry.method);
    expect(
      requests.indexOf(mode === 'create' ? 'thread/start' : 'thread/resume'),
    ).toBeGreaterThan(-1);
    expect(
      requests.indexOf(mode === 'create' ? 'thread/start' : 'thread/resume'),
    ).toBeLessThan(requests.indexOf('turn/start'));
  },
);
it.each([
  'thread-rpc-error',
  'thread-mismatch',
  'thread-malformed',
  'thread-disconnect',
  'thread-timeout',
])('never starts a turn or retries after %s', async (scenario) => {
  const result = await controller.run(spec, scenario, 'resume');
  expect(result.state).toBe('needs_attention');
  expect(store.providers.get('connection').status).toBe('unknown');
  const requests = store.providers
    .entries('connection')
    .filter((entry) => entry.direction === 'out');
  expect(
    requests.filter((entry) => entry.method === 'thread/resume'),
  ).toHaveLength(1);
  expect(
    requests.filter((entry) => entry.method === 'turn/start'),
  ).toHaveLength(0);
  expect(store.providers.get('connection').verification).toBeUndefined();
});
it.each(['native-error', 'native-retry', 'turn-rpc-error', 'turn-failed'])(
  'keeps %s away from verification and acceptance',
  async (scenario) => {
    const result = await controller.run(spec, scenario);
    expect(result.state).toBe('needs_attention');
    expect(store.providers.get('connection').verification).toBeUndefined();
    expect(store.providers.occupied('workspace:workspace')).toBe(true);
    expect(
      store.providers
        .entries('connection')
        .filter(
          (entry) => entry.direction === 'out' && entry.method === 'turn/start',
        ),
    ).toHaveLength(1);
  },
);
