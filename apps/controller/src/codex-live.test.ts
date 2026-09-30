import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { createWorktree } from '../../../packages/storage/src/git-workspace.ts';
import { verifiedWorkspaceObjects } from '../../../packages/storage/src/workspace.ts';
import { LIVE_ROUTES } from '../../../packages/contracts/src/live.ts';
import { LiveCodexController, type LiveEvent } from './codex-live.ts';

let root: string,
  store: Store,
  objects: ArtifactStore,
  controller: LiveCodexController;
let worktree: { path: string; baseCommit: string };
const events: LiveEvent[] = [];
const peer = fileURLToPath(
  new URL('../../../tests/fixtures/codex-live-peer.mjs', import.meta.url),
);
const spec = (over: Record<string, unknown> = {}) => ({
  connectionId: 'connection',
  taskId: 'task',
  attemptId: 'attempt',
  workspaceId: 'workspace',
  expectedVersion: 1,
  classification: 'live' as const,
  liveApproval: {
    actorId: 'operator',
    model: 'default',
    transport: 'app-server' as const,
    userApprovedTrustedLocal: true as const,
    profile: 'workspace-write' as const,
    acknowledgedNativeBypass: true as const,
  },
  worker: {
    id: 'codex-1',
    alias: 'codex-1',
    runtimeKind: 'codex' as const,
    hostId: 'host',
    endpointId: 'app-server',
    nativeSessionId: 'pending:connection',
    runtimeVersion: LIVE_ROUTES.codex.runtimeVersion,
    adapterVersion: LIVE_ROUTES.codex.adapterVersion,
    mode: 'managed' as const,
    quotaGroupId: 'chatgpt',
  },
  ...over,
});
function setup(scenario = 'write', timeoutMs = 5000) {
  controller = new LiveCodexController(
    store,
    objects,
    { workspace: worktree.path },
    {
      check: {
        executable: process.execPath,
        args: [
          '-e',
          "if(require('node:fs').readFileSync('hello.txt','utf8').trim()!=='hi from codex')process.exit(1)",
        ],
      },
    },
    {
      executable: process.execPath,
      prefixArgs: [peer, scenario],
      timeoutMs,
      gitBases: { workspace: worktree.baseCommit },
      onEvent: (event) => events.push(event),
    },
  );
  return controller;
}
beforeEach(() => {
  events.length = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-codex-live-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  worktree = createWorktree(repo, 'main', join(root, 'wt'), 'xvant/codex-1');
  store = new Store(join(root, 'state.sqlite'), { owner: 'test' });
  objects = new ArtifactStore(join(root, 'objects'));
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Create hello.txt containing: hi from codex',
    requiredCheckIds: ['check'],
    acceptanceCriteria: ['hello.txt exists'],
  });
  store.queue('queue', 'task', 0);
});
afterEach(() => {
  controller?.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it('edits its worktree, binds identities and prepares patch evidence for review', async () => {
  const result = await setup().run(spec(), 'create');
  expect(result.task.state).toBe('ready_for_acceptance');
  expect(result.finalText).toBe('Created hello.txt.');
  expect(result.tokens).toBe(1234);
  expect(result.auth).toEqual({ mode: 'chatgpt', plan: 'plus' });
  const saved = store.providers.get('connection');
  expect(saved.worker.nativeSessionId).toBe(
    '01a0f355-2260-71d2-bd32-9fd8718d9045',
  );
  expect(saved.nativeRunId).toBe('01a0f355-24f5-7903-b322-6915d609062d');
  const evidence = store.providers.acceptanceEvidence('connection');
  const manifest = JSON.parse(objects.get(evidence.treeHash).toString());
  expect(manifest.files).toEqual([{ path: 'hello.txt', status: 'A' }]);
  expect(objects.get(manifest.patch).toString()).toContain('+hi from codex');
  expect(verifiedWorkspaceObjects(objects, evidence)).toContain(manifest.patch);
  // Telemetry is streamed to observers but not journaled.
  const methods = store.providers.entries('connection').map((e) => e.method);
  expect(methods).toContain('turn/completed');
  expect(
    methods.some((m) => m?.endsWith('Delta') || m?.endsWith('delta')),
  ).toBe(false);
  expect(events.some((e) => e.kind === 'text')).toBe(true);
  expect(controller.activeCount).toBe(0);
});

it('stops before any thread when the session is not on the subscription login', async () => {
  const result = await setup('api-key').run(spec(), 'create');
  expect(result.task.state).toBe('needs_attention');
  const methods = store.providers
    .entries('connection')
    .filter((e) => e.direction === 'out')
    .map((e) => e.method);
  expect(methods).toEqual(['initialize', 'initialized']);
  expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toContain(
    'fixture',
  );
});

it('records a failed turn without verification', async () => {
  const result = await setup('fail').run(spec(), 'create');
  const saved = store.providers.get('connection');
  expect(saved.outcome).toBe('failed');
  expect(saved.failure?.code).toBe('QUOTA_BLOCKED');
  expect(saved.verification).toBeUndefined();
  expect(result.task.state).toBe('needs_attention');
});

it('interrupts a running turn through host admission', async () => {
  const c = setup('hang', 10000);
  const running = c.run(spec(), 'create');
  let admitted;
  for (let i = 0; i < 200 && !admitted; i++) {
    await new Promise((r) => setTimeout(r, 25));
    try {
      admitted = c.interrupt('connection', 'operator');
    } catch {
      /* not running yet */
    }
  }
  expect(admitted).toEqual({ status: 'requested' });
  await running;
  const saved = store.providers.get('connection');
  expect(saved.outcome).toBe('cancelled');
  expect(saved.interrupt?.actorId).toBe('operator');
});

it('rejects write access without acknowledged native bypass', async () => {
  const s = spec();
  delete (s.liveApproval as Record<string, unknown>).acknowledgedNativeBypass;
  await expect(setup().run(s, 'create')).rejects.toThrow();
  expect(() => store.providers.get('connection')).toThrow('NOT_FOUND');
});

it('times out as unknown without replaying the turn', async () => {
  const result = await setup('hang', 1500).run(spec(), 'create');
  expect(result.task.state).toBe('needs_attention');
  const saved = store.providers.get('connection');
  expect(saved.status).toBe('unknown');
  expect(
    store.providers
      .entries('connection')
      .filter((e) => e.method === 'turn/start'),
  ).toHaveLength(1);
});
