import { beforeEach, afterEach, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { NativeReviewController } from './native-review.ts';
import { LiveOpenCodeController } from './opencode-live.ts';
let root: string,
  workspace: string,
  store: Store,
  objects: ArtifactStore,
  controller: LiveOpenCodeController;
const approval = {
  actorId: 'operator',
  model: 'opencode/big-pickle' as const,
  transport: 'cli' as const,
  userApprovedTrustedLocal: true as const,
};
const spec = {
  connectionId: 'connection',
  taskId: 'task',
  attemptId: 'attempt',
  workspaceId: 'workspace',
  expectedVersion: 1,
  classification: 'live' as const,
  liveApproval: approval,
  worker: {
    id: 'worker',
    alias: 'worker',
    runtimeKind: 'opencode' as const,
    hostId: 'host',
    endpointId: 'cli',
    nativeSessionId: 'ses_initial',
    runtimeVersion: '2.0.19',
    adapterVersion: 'opencode-cli-v2',
    mode: 'managed' as const,
    quotaGroupId: 'account',
  },
};
function setup(scenario = 'success', fault?: (point: string) => void) {
  controller = new LiveOpenCodeController(
    store,
    objects,
    { workspace },
    {
      check: {
        executable: process.execPath,
        args: [
          '-e',
          "if(require('node:fs').readFileSync('.xvant-result-attempt.txt','utf8')!=='XVANT_LIVE_OK')process.exit(1)",
        ],
      },
    },
    {
      executable: process.execPath,
      prefixArgs: [
        fileURLToPath(
          new URL('../../../tests/fixtures/opencode-cli.mjs', import.meta.url),
        ),
        scenario,
      ],
      timeoutMs: 2000,
      ...(fault ? { fault } : {}),
    },
  );
  return controller;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-live-test-'));
  workspace = join(root, 'work');
  mkdirSync(workspace);
  store = new Store(join(root, 'state.sqlite'), { owner: 'test' });
  objects = new ArtifactStore(join(root, 'objects'));
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Reply XVANT_LIVE_OK',
    requiredCheckIds: ['check'],
    acceptanceCriteria: ['Output matches'],
  });
  store.queue('queue', 'task', 0);
});
afterEach(() => {
  controller?.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
it('journals before launch, verifies output, and accepts live evidence explicitly after restart', async () => {
  const task = await setup().run(spec);
  expect(task.state).toBe('ready_for_acceptance');
  const saved = store.providers.get('connection');
  expect(saved.classification).toBe('live');
  expect(saved.liveApproval).toEqual(approval);
  expect(saved.verification?.status).toBe('passed');
  expect(saved.worker.nativeSessionId).toMatch(/^ses_/);
  expect(saved.worker.nativeSessionId).not.toBe('ses_initial');
  expect(
    store.providers
      .entries('connection')
      .filter((x) => x.direction === 'out')
      .map((x) => x.method),
  ).toEqual(['session/create', 'opencode/cli-run']);
  expect(existsSync(join(workspace, '.opencode'))).toBe(false);
  expect(
    readFileSync(join(workspace, '.xvant-result-attempt.txt'), 'utf8'),
  ).toBe('XVANT_LIVE_OK');
  expect(controller.activeCount).toBe(0);
  store.close();
  store = new Store(join(root, 'state.sqlite'), { owner: 'test' });
  const review = new NativeReviewController(store, objects);
  const evidence = store
    .events(0)
    .find((e) => e.kind === 'native.ready_for_acceptance')!.payload as {
    rowVersion: number;
    evidenceHash: string;
  };
  expect(() =>
    review.accept('bad', {
      connectionId: 'connection',
      expectedVersion: evidence.rowVersion,
      reviewedEvidenceHash: evidence.evidenceHash,
      actorId: 'operator',
      classification: 'offline',
    }),
  ).toThrow();
  expect(
    review.accept('accept', {
      connectionId: 'connection',
      expectedVersion: evidence.rowVersion,
      reviewedEvidenceHash: evidence.evidenceHash,
      actorId: 'operator',
      classification: 'live',
    }).state,
  ).toBe('accepted');
});
it.each(['malformed', 'wrong-session', 'nonzero', 'timeout'])(
  'retains reservations without acceptance on %s',
  async (scenario) => {
    await setup(scenario).run(spec);
    expect(store.providers.get('connection').status).toBe('unknown');
    expect(store.providers.occupied('workspace:workspace')).toBe(true);
    expect(store.getTask('task').state).toBe('needs_attention');
    expect(existsSync(join(workspace, '.xvant-result-attempt.txt'))).toBe(
      false,
    );
    expect(controller.activeCount).toBe(0);
  },
);
it('blocks account on v2 auth failure without persisting raw error text', async () => {
  await setup('auth').run(spec);
  expect(store.providers.blocked('account')?.code).toBe('AUTH_REQUIRED');
  expect(JSON.stringify(store.providers.entries('connection'))).not.toContain(
    'private error',
  );
});
it.each(['create-malformed', 'create-wrong-root', 'create-nonzero'])(
  'never dispatches inference after invalid provisioning: %s',
  async (scenario) => {
    await setup(scenario).run(spec);
    expect(store.providers.get('connection').status).toBe('unknown');
    expect(store.providers.get('connection').worker.nativeSessionId).toBe(
      'pending:connection',
    );
    expect(
      store.providers
        .entries('connection')
        .filter((x) => x.direction === 'out')
        .map((x) => x.method),
    ).toEqual(['session/create']);
    expect(controller.activeCount).toBe(0);
  },
);
it('refuses missing live approval and unpinned executable before dispatch', async () => {
  await expect(
    setup().run({ ...spec, liveApproval: undefined } as never),
  ).rejects.toThrow();
  expect(store.getTask('task').state).toBe('queued');
  await expect(setup('version').run(spec)).rejects.toThrow(
    'VERSION_UNSUPPORTED',
  );
  expect(store.getTask('task').state).toBe('queued');
});
it('persists interrupt admission before process cancellation and retains uncertainty', async () => {
  const pending = setup('interrupt').run(spec);
  let admitted = false;
  for (let i = 0; i < 200 && !admitted; i++) {
    try {
      controller.interrupt('connection', 'operator');
      admitted = true;
    } catch {}
    if (!admitted) await new Promise((r) => setTimeout(r, 10));
  }
  expect(admitted).toBe(true);
  await pending;
  expect(store.providers.get('connection').interrupt?.actorId).toBe('operator');
  expect(store.providers.get('connection').status).toBe('unknown');
  expect(controller.activeCount).toBe(0);
});
it.each(['live.after_reserve', 'live.after_intent', 'live.after_shutdown'])(
  'retains durable work on injected failure at %s',
  async (point) => {
    await setup('success', (p) => {
      if (p === point) throw new Error('injected');
    }).run(spec);
    expect(store.providers.get('connection').status).toBe('unknown');
    expect(store.providers.occupied('workspace:workspace')).toBe(true);
    expect(controller.activeCount).toBe(0);
  },
);
it('snapshots caller inputs before asynchronous inventory', async () => {
  const mutable = structuredClone(spec);
  const pending = setup().run(mutable);
  mutable.attemptId = 'changed';
  mutable.worker.id = 'changed';
  await pending;
  expect(store.providers.get('connection').attemptId).toBe('attempt');
  expect(store.providers.get('connection').worker.id).toBe('worker');
});
it('persists an auth block when valid error is followed by malformed output', async () => {
  await setup('auth-malformed').run(spec);
  expect(store.providers.blocked('account')?.code).toBe('AUTH_REQUIRED');
  expect(store.providers.get('connection').status).toBe('unknown');
});
it('refuses cross-project resume of an accepted native session', async () => {
  await setup().run(spec);
  const ready = store
    .events(0)
    .find((e) => e.kind === 'native.ready_for_acceptance')!.payload as {
    rowVersion: number;
    evidenceHash: string;
  };
  new NativeReviewController(store, objects).accept('accept', {
    connectionId: 'connection',
    expectedVersion: ready.rowVersion,
    reviewedEvidenceHash: ready.evidenceHash,
    actorId: 'operator',
    classification: 'live',
  });
  store.create('create2', {
    id: 'task2',
    projectId: 'other',
    objective: 'Other project',
    requiredCheckIds: ['check'],
    acceptanceCriteria: ['Pass'],
  });
  store.queue('queue2', 'task2', 0);
  await expect(
    controller.run(
      {
        ...spec,
        taskId: 'task2',
        connectionId: 'connection2',
        attemptId: 'attempt2',
      },
      'connection',
    ),
  ).rejects.toThrow('RESUME_UNVERIFIED');
});

function writer(scenario: string) {
  controller = new LiveOpenCodeController(
    store,
    objects,
    { workspace },
    {
      check: {
        executable: process.execPath,
        args: [
          '-e',
          "if(require('node:fs').readFileSync('hello.txt','utf8').trim()!=='hi from opencode')process.exit(1)",
        ],
      },
    },
    {
      executable: process.execPath,
      prefixArgs: [
        fileURLToPath(
          new URL('../../../tests/fixtures/opencode-cli.mjs', import.meta.url),
        ),
        scenario,
      ],
      timeoutMs: 5000,
    },
  );
  return controller;
}
const writeSpec = {
  ...spec,
  liveApproval: {
    ...approval,
    profile: 'workspace-write' as const,
    acknowledgedNativeBypass: true as const,
  },
};
it('lets a workspace-write run edit through its own tools, without a host result file', async () => {
  const result = await writer('tools').runLive(writeSpec);
  expect(result.task.state).toBe('ready_for_acceptance');
  expect(result.finalText).toBe('Created hello.txt.');
  expect(result.tokens).toBe(100);
  expect(store.providers.get('connection').nativeRunId).toBe('msg_2');
  expect(existsSync(join(workspace, '.xvant-result-attempt.txt'))).toBe(false);
});
it('stops a run that reports any billed step', async () => {
  const result = await writer('billed').runLive(writeSpec);
  expect(result.task.state).toBe('needs_attention');
  expect(store.providers.get('connection').status).toBe('unknown');
});
it('refuses workspace writes without acknowledged native bypass', async () => {
  await expect(
    writer('tools').runLive({
      ...spec,
      liveApproval: { ...approval, profile: 'workspace-write' as const },
    }),
  ).rejects.toThrow();
  expect(() => store.providers.get('connection')).toThrow('NOT_FOUND');
});
