import { beforeEach, afterEach, expect, it, vi } from 'vitest';
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
it('refuses live qualification on the fixed offline controller', async () => {
  await expect(
    controller.run({ ...spec, classification: 'live' }),
  ).rejects.toThrow('LIVE_DISABLED');
});
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
it.each(['disconnect', 'malformed', 'timeout', 'late-malformed'])(
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
const withFault = (fault: (point: string) => void) => {
  controller.stop();
  controller = new OfflineCodexController(
    store,
    objects,
    { workspace: join(root, 'work') },
    { test: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } },
    { timeoutMs: 2000, fault },
  );
};
const outgoing = (method: string) =>
  store.providers
    .entries('connection')
    .filter((entry) => entry.direction === 'out' && entry.method === method);
async function interrupted(scenario = 'interrupt') {
  const pending = controller.run(spec, scenario);
  const admission = await vi.waitFor(
    () => controller.interrupt('connection', 'operator'),
    { timeout: 1500, interval: 5 },
  );
  return { admission, task: await pending };
}
it('interrupts a running turn only after durable host admission', async () => {
  const { admission, task } = await interrupted();
  expect(admission).toEqual({ status: 'requested' });
  expect(task.state).toBe('needs_attention');
  const saved = store.providers.get('connection');
  expect(saved).toMatchObject({
    status: 'result_pending',
    outcome: 'cancelled',
    interrupt: { actorId: 'operator' },
  });
  expect(saved.verification).toBeUndefined();
  const methods = store.providers
    .entries('connection')
    .filter((entry) => entry.direction === 'out')
    .map((entry) => entry.method);
  expect(methods.slice(-2)).toEqual(['turn/start', 'turn/interrupt']);
  expect(
    store.events(0).filter((e) => e.kind === 'provider.interrupt_requested'),
  ).toHaveLength(1);
  expect(store.providers.occupied('workspace:workspace')).toBe(true);
  expect(controller.activeCount).toBe(0);
});
it('makes repeated Codex interrupt admission idempotent', async () => {
  const pending = controller.run(spec, 'interrupt');
  await vi.waitFor(() => controller.interrupt('connection', 'operator'), {
    timeout: 1500,
    interval: 5,
  });
  expect(controller.interrupt('connection', 'other')).toEqual({
    status: 'already_requested',
  });
  await pending;
  expect(outgoing('turn/interrupt')).toHaveLength(1);
});
it('never sends turn/interrupt for a holding turn without admission', async () => {
  expect((await controller.run(spec, 'interrupt')).state).toBe(
    'needs_attention',
  );
  expect(store.providers.get('connection').status).toBe('unknown');
  expect(store.providers.get('connection').interrupt).toBeUndefined();
  expect(outgoing('turn/interrupt')).toHaveLength(0);
});
it.each(['interrupt-error', 'interrupt-ignored'])(
  'keeps an admitted interrupt unknown after %s',
  async (scenario) => {
    const { task } = await interrupted(scenario);
    expect(task.state).toBe('needs_attention');
    expect(store.providers.get('connection')).toMatchObject({
      status: 'unknown',
      outcome: null,
    });
    expect(store.providers.get('connection').verification).toBeUndefined();
    expect(outgoing('turn/interrupt')).toHaveLength(1);
    expect(controller.activeCount).toBe(0);
  },
);
it('rejects Codex interrupt before dispatch and after the terminal turn', async () => {
  const errors: string[] = [];
  withFault((point) => {
    if (point !== 'codex.after_session' && point !== 'codex.after_shutdown')
      return;
    try {
      controller.interrupt('connection', 'operator');
    } catch (error) {
      errors.push((error as Error).message);
    }
  });
  expect((await controller.run(spec)).state).toBe('ready_for_acceptance');
  expect(errors).toEqual(['NOT_INTERRUPTIBLE', 'NOT_INTERRUPTIBLE']);
  expect(outgoing('turn/interrupt')).toHaveLength(0);
  expect(() => controller.interrupt('connection', 'operator')).toThrow(
    'NOT_FOUND',
  );
  controller.stop();
  expect(() => controller.interrupt('connection', 'operator')).toThrow(
    'CONTROLLER_STOPPED',
  );
});
it('fences Codex interrupt admission after controller takeover', async () => {
  let recovery: Store | undefined;
  const errors: string[] = [];
  withFault((point) => {
    if (point !== 'codex.interruptible') return;
    recovery = new Store(join(root, 'state.sqlite'), {
      owner: 'recovery',
      now: () => Date.now() + 120000,
    });
    try {
      controller.interrupt('connection', 'operator');
    } catch (error) {
      errors.push((error as Error).message);
    }
    controller.stop();
  });
  try {
    await controller.run(spec, 'interrupt');
    expect(errors).toEqual(['STALE_FENCE']);
    expect(recovery!.recover()).toEqual(['attempt']);
    expect(recovery!.providers.get('connection').interrupt).toBeUndefined();
    expect(outgoing('turn/interrupt')).toHaveLength(0);
    expect(controller.activeCount).toBe(0);
  } finally {
    recovery?.close();
  }
});
it.each([
  ['native-error', 'unknown', null, 'QUOTA_BLOCKED', 'usageLimitExceeded'],
  ['auth-failed', 'result_pending', 'failed', 'AUTH_REQUIRED', 'unauthorized'],
] as const)(
  'classifies Codex %s and blocks the account group',
  async (scenario, status, outcome, code, native) => {
    expect((await controller.run(spec, scenario)).state).toBe(
      'needs_attention',
    );
    expect(store.providers.get('connection')).toMatchObject({
      status,
      outcome,
      failure: { code, scope: 'quota_group', native },
    });
    expect(store.providers.blocked('account')?.code).toBe(code);
  },
);
it('keeps an unlabeled failed Codex turn attempt-scoped', async () => {
  await controller.run(spec, 'turn-failed');
  expect(store.providers.get('connection').failure).toEqual({
    code: 'WORKER_FAILED',
    scope: 'attempt',
    native: 'none',
  });
  expect(store.providers.blocked('account')).toBeUndefined();
});
it('records no failure for a confirmed Codex interrupt', async () => {
  await interrupted();
  expect(store.providers.get('connection').failure).toBeUndefined();
});
