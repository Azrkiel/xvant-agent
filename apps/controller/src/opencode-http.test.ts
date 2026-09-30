import { afterEach, beforeEach, expect, it, vi } from 'vitest';
it('refuses live qualification on the fixed HTTP controller', async () => {
  await expect(
    controller.run({ ...spec, classification: 'live' }),
  ).rejects.toThrow('LIVE_DISABLED');
});
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { versions } from '../../../packages/adapters/src/providers/native-profiles.ts';
import { OfflineOpenCodeHttpController } from './opencode-http.ts';

let root: string, store: Store, controller: OfflineOpenCodeHttpController;
let fault: (point: string) => void;
const spec = {
  connectionId: 'connection',
  taskId: 'task',
  attemptId: 'attempt-http',
  workspaceId: 'workspace',
  expectedVersion: 1,
  classification: 'offline' as const,
  worker: {
    id: 'worker',
    alias: 'worker',
    runtimeKind: 'opencode' as const,
    hostId: 'host',
    endpointId: 'loopback',
    nativeSessionId: 'session-1',
    runtimeVersion: versions.opencode,
    adapterVersion: 'v1',
    mode: 'managed' as const,
    quotaGroupId: 'account',
  },
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-opencode-http-'));
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
  controller = new OfflineOpenCodeHttpController(
    store,
    new ArtifactStore(join(root, 'objects')),
    { workspace },
    { test: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } },
    { timeoutMs: 3000, fault: (point) => fault(point) },
  );
});
afterEach(() => {
  controller.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const outgoing = () =>
  store.providers
    .entries('connection')
    .filter((entry) => entry.direction === 'out');
it.each(['success', 'permission'])(
  'runs %s over an owned authenticated endpoint through review',
  async (scenario) => {
    expect((await controller.run(spec, scenario)).state).toBe(
      'ready_for_acceptance',
    );
    const saved = store.providers.get('connection');
    expect(saved.verification?.status).toBe('passed');
    expect(saved.endpoint).toMatchObject({
      origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      credentialSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      version: versions.opencode,
    });
    expect(saved.nativeRunId).toBe('assistant-1');
    expect(outgoing().map((entry) => entry.method)).toEqual([
      'opencode/serve',
      'session/get',
      'session/prompt',
      ...(scenario === 'permission' ? ['permission/reply'] : []),
    ]);
    const prompt = JSON.parse(outgoing()[2]!.frame!);
    expect(prompt.body.messageID).toBe('attempt-http');
    expect(controller.activeCount).toBe(0);
  },
);
it('never journals or persists the endpoint secret', async () => {
  await controller.run(spec, 'permission');
  const serve = JSON.parse(outgoing()[0]!.frame!);
  expect(serve.env).toEqual(['OPENCODE_SERVER_PASSWORD']);
  expect(Object.keys(serve).sort()).toEqual([
    'args',
    'credentialSha256',
    'env',
  ]);
  const dump = JSON.stringify([
    store.providers.get('connection'),
    store.providers.entries('connection'),
    store.events(0),
  ]);
  expect(dump).not.toMatch(/basic /i);
  expect(dump).not.toContain('authorization');
});
it.each([
  ['no-auth', 'an unauthenticated server'],
  ['wrong-version', 'an unpinned server version'],
  ['announce-remote', 'a non-loopback announcement'],
])('refuses %s (%s) before any session traffic', async (scenario) => {
  expect((await controller.run(spec, scenario)).state).toBe('needs_attention');
  expect(store.providers.get('connection')).toMatchObject({
    status: 'unknown',
  });
  expect(store.providers.get('connection').endpoint).toBeUndefined();
  expect(outgoing().map((entry) => entry.method)).toEqual(['opencode/serve']);
  expect(controller.activeCount).toBe(0);
});
it('creates and binds a session over HTTP before prompting', async () => {
  expect((await controller.run(spec, 'success', 'create')).state).toBe(
    'ready_for_acceptance',
  );
  const saved = store.providers.get('connection');
  expect(saved.worker.nativeSessionId).toBe('created-1');
  expect(saved.sessionBound).toBe(true);
  expect(outgoing().map((entry) => entry.method)).toEqual([
    'opencode/serve',
    'session/create',
    'session/prompt',
  ]);
});
it.each(['setup-mismatch', 'create-permission'])(
  'never prompts after %s',
  async (scenario) => {
    const mode = scenario === 'create-permission' ? 'create' : 'resume';
    expect((await controller.run(spec, scenario, mode)).state).toBe(
      'needs_attention',
    );
    expect(
      outgoing().filter((entry) => entry.method === 'session/prompt'),
    ).toHaveLength(0);
    expect(controller.activeCount).toBe(0);
  },
);
it('admits a host interrupt and confirms abort before cancelling', async () => {
  const pending = controller.run(spec, 'interrupt');
  const admission = await vi.waitFor(
    () => controller.interrupt('connection', 'operator'),
    { timeout: 2000, interval: 5 },
  );
  expect(admission).toEqual({ status: 'requested' });
  expect((await pending).state).toBe('needs_attention');
  const saved = store.providers.get('connection');
  expect(saved).toMatchObject({
    outcome: 'cancelled',
    status: 'result_pending',
  });
  expect(saved.failure).toBeUndefined();
  expect(outgoing().at(-1)?.method).toBe('session/abort');
});
it('times out a holding turn without admission and never aborts', async () => {
  expect((await controller.run(spec, 'interrupt')).state).toBe(
    'needs_attention',
  );
  expect(store.providers.get('connection').status).toBe('unknown');
  expect(
    outgoing().filter((entry) => entry.method === 'session/abort'),
  ).toHaveLength(0);
  expect(controller.activeCount).toBe(0);
});
it.each([
  ['error', 'unknown', 'WORKER_FAILED'],
  ['quota-error', 'result_pending', 'QUOTA_BLOCKED'],
] as const)(
  'classifies %s from the event stream',
  async (scenario, status, code) => {
    await controller.run(spec, scenario);
    expect(store.providers.get('connection')).toMatchObject({
      status,
      failure: { code },
    });
    expect(store.providers.blocked('account')?.code).toBe(
      code === 'QUOTA_BLOCKED' ? code : undefined,
    );
  },
);
it('does not launch after stop between intent and startup', async () => {
  fault = (point) => {
    if (point === 'opencode.before_launch') controller.stop();
  };
  expect((await controller.run(spec)).state).toBe('needs_attention');
  expect(outgoing().map((entry) => entry.method)).toEqual(['opencode/serve']);
  expect(controller.activeCount).toBe(0);
});
it('fences a stale owner after endpoint binding', async () => {
  let recovery: Store | undefined;
  fault = (point) => {
    if (point !== 'opencode.after_endpoint') return;
    recovery = new Store(join(root, 'state.sqlite'), {
      owner: 'recovery',
      now: () => Date.now() + 120000,
    });
  };
  try {
    await controller.run(spec);
    expect(recovery!.recover()).toEqual(['attempt-http']);
    expect(
      outgoing().filter((entry) => entry.method === 'session/prompt'),
    ).toHaveLength(0);
    expect(controller.activeCount).toBe(0);
  } finally {
    recovery?.close();
  }
});
it('rejects non-OpenCode or unpinned workers before reservation', async () => {
  await expect(
    controller.run({
      ...spec,
      worker: { ...spec.worker, runtimeVersion: '0.0.1' },
    }),
  ).rejects.toThrow('VERSION_UNSUPPORTED');
  await expect(controller.run(spec, 'live')).rejects.toThrow();
  expect(store.getTask('task').state).toBe('queued');
});
