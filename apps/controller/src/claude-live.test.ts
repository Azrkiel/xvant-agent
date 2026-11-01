import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as supervisor from '../../../packages/supervisor/src/index.ts';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { LIVE_ROUTES } from '../../../packages/contracts/src/live.ts';
import {
  claudeArgs,
  ClaudeHeadlessStream,
} from '../../../packages/adapters/src/live/claude-headless.ts';
import { LiveClaudeController, claudeUnsetEnv } from './claude-live.ts';

const SESSION = '6306ed11-5ca4-4c61-a177-5b64eddf5d5b';
let root: string,
  store: Store,
  objects: ArtifactStore,
  controller: LiveClaudeController;
let worktree: { path: string; baseCommit: string };
const peer = fileURLToPath(
  new URL('../../../tests/fixtures/claude-live-peer.mjs', import.meta.url),
);
const spec = () => ({
  connectionId: 'connection',
  taskId: 'task',
  attemptId: 'attempt',
  workspaceId: 'workspace',
  expectedVersion: 1,
  classification: 'live' as const,
  liveApproval: {
    actorId: 'operator',
    model: 'default',
    transport: 'headless' as const,
    userApprovedTrustedLocal: true as const,
    profile: 'workspace-write' as const,
    acknowledgedNativeBypass: true as const,
  },
  worker: {
    id: 'claude-1',
    alias: 'claude-1',
    runtimeKind: 'claude' as const,
    hostId: 'host',
    endpointId: 'headless',
    nativeSessionId: SESSION,
    runtimeVersion: LIVE_ROUTES.claude.runtimeVersion,
    adapterVersion: LIVE_ROUTES.claude.adapterVersion,
    mode: 'managed' as const,
    quotaGroupId: 'claude-pro',
  },
});
function setup(scenario = 'write', timeoutMs = 5000) {
  controller = new LiveClaudeController(
    store,
    objects,
    { workspace: worktree.path },
    {
      check: {
        executable: process.execPath,
        args: [
          '-e',
          "if(require('node:fs').readFileSync('hello.txt','utf8').trim()!=='hi from claude')process.exit(1)",
        ],
      },
    },
    {
      executable: process.execPath,
      prefixArgs: [peer, scenario],
      timeoutMs,
      gitBases: { workspace: worktree.baseCommit },
    },
  );
  return controller;
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-claude-live-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  worktree = createWorktree(repo, 'main', join(root, 'wt'), 'xvant/claude-1');
  store = new Store(join(root, 'state.sqlite'), { owner: 'test' });
  objects = new ArtifactStore(join(root, 'objects'));
  store.create('create', {
    id: 'task',
    projectId: 'project',
    objective: 'Create hello.txt containing: hi from claude',
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

it('builds explicit-session arguments without user MCP servers or network tools', () => {
  const args = claudeArgs({
    mode: 'resume',
    sessionId: SESSION,
    model: 'default',
    profile: 'text',
  });
  expect(args).toContain('--resume');
  expect(args).toContain('--strict-mcp-config');
  expect(args).toContain('--disallowedTools=WebFetch,WebSearch');
  expect(args.join(' ')).not.toContain('Bash');
  expect(args).not.toContain('--continue');
  expect(() =>
    claudeArgs({
      mode: 'create',
      sessionId: 'latest',
      model: 'default',
      profile: 'text',
    }),
  ).toThrow('SESSION_MISMATCH');
});

it('removes API-key and nested-session variables from the child', () =>
  expect(
    claudeUnsetEnv({
      ANTHROPIC_API_KEY: 'x',
      anthropic_base_url: 'x',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      PATH: 'x',
      CLAUDE_CONFIG_DIR: 'kept',
    }).sort(),
  ).toEqual(
    [
      'ANTHROPIC_API_KEY',
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'anthropic_base_url',
    ].sort(),
  ));

it('edits its worktree and prepares verified evidence on the reserved session', async () => {
  const result = await setup().run(spec(), 'create');
  expect(result.task.state).toBe('ready_for_acceptance');
  expect(result.finalText).toBe('DONE');
  expect(result.tokens).toBe(120);
  const saved = store.providers.get('connection');
  expect(saved.worker.nativeSessionId).toBe(SESSION);
  expect(saved.nativeRunId).toBe('result-1');
  const out = store.providers
    .entries('connection')
    .filter((e) => e.direction === 'out');
  expect(out.map((e) => e.method)).toEqual(['claude/headless-run']);
  // init, two assistant messages and the result; rate-limit telemetry is skipped.
  expect(
    store.providers.entries('connection').filter((e) => e.direction === 'in'),
  ).toHaveLength(4);
  expect(controller.activeCount).toBe(0);
});

it('refuses a session that reports an API key', async () => {
  const result = await setup('api-key').run(spec(), 'create');
  expect(result.task.state).toBe('needs_attention');
  expect(store.providers.get('connection').status).toBe('unknown');
  expect(store.providers.get('connection').outcome).toBeNull();
});

it('refuses a stream for another session', async () => {
  await setup('wrong-session').run(spec(), 'create');
  expect(store.providers.get('connection').status).toBe('unknown');
});

it('records a classified account failure', async () => {
  await setup('fail').run(spec(), 'create');
  const saved = store.providers.get('connection');
  expect(saved.outcome).toBe('failed');
  expect(saved.failure).toMatchObject({
    code: 'QUOTA_BLOCKED',
    scope: 'quota_group',
  });
});

it('cancels an owned process before its init frame without an unknown outcome', async () => {
  const c = setup('before-init', 20000);
  const running = c.run(spec(), 'create');
  try {
    for (let i = 0; i < 400; i++) {
      if (existsSync(join(worktree.path, 'before-init.started'))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(join(worktree.path, 'before-init.started'))).toBe(true);
    expect(c.interrupt('connection', 'operator')).toEqual({
      status: 'requested',
    });
    await running;
    const saved = store.providers.get('connection');
    expect(saved.outcome).toBe('cancelled');
    expect(saved.interrupt?.actorId).toBe('operator');
    expect(saved.status).not.toBe('unknown');
    expect(c.activeCount).toBe(0);
  } finally {
    c.stop();
    await running;
  }
});

it('cancels while prompt delivery is blocked without leaving an unknown lease', async () => {
  const c = setup('blocked-input', 20000);
  // Hold the write at its async boundary: pipe capacities vary across hosts.
  const realWrite = supervisor.writeChunked;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = vi
    .spyOn(supervisor, 'writeChunked')
    .mockImplementation(async (...args) => {
      await gate;
      return realWrite(...args);
    });
  const running = c.run(spec(), 'create');
  try {
    for (let i = 0; i < 400; i++) {
      if (existsSync(join(worktree.path, 'blocked-input.started'))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(join(worktree.path, 'blocked-input.started'))).toBe(true);
    expect(writing).toHaveBeenCalled();
    expect(c.interrupt('connection', 'operator')).toEqual({
      status: 'requested',
    });
    release();
    await running;
    expect(store.providers.get('connection').outcome).toBe('cancelled');
    expect(store.providers.get('connection').status).not.toBe('unknown');
    expect(c.activeCount).toBe(0);
  } finally {
    c.stop();
    release();
    await running;
    writing.mockRestore();
  }
});

it('retains the unknown lease when a rejected auth frame races an admitted cancel', async () => {
  const c = setup('api-key', 20000);
  const receive = ClaudeHeadlessStream.prototype.receive;
  let cancelled = false;
  const reading = vi
    .spyOn(ClaudeHeadlessStream.prototype, 'receive')
    .mockImplementation(function (this: ClaudeHeadlessStream, bytes) {
      if (!cancelled) {
        expect(c.interrupt('connection', 'operator')).toEqual({
          status: 'requested',
        });
        cancelled = true;
      }
      // The real parser rejects the fixture's API-key init frame after admission.
      return receive.call(this, bytes);
    });
  try {
    await c.run(spec(), 'create');
    expect(cancelled).toBe(true);
    const saved = store.providers.get('connection');
    expect(saved.status).toBe('unknown');
    expect(saved.outcome).toBeNull();
    expect(store.providers.occupied('worker:claude-1')).toBe(true);
    expect(c.activeCount).toBe(0);
  } finally {
    reading.mockRestore();
  }
});

it('cancels a running turn by stopping its owning process', async () => {
  const c = setup('hang', 20000);
  const running = c.run(spec(), 'create');
  let admitted;
  for (let i = 0; i < 400 && !admitted; i++) {
    await new Promise((r) => setTimeout(r, 25));
    try {
      admitted = c.interrupt('connection', 'operator');
    } catch {
      /* not started */
    }
  }
  expect(admitted).toEqual({ status: 'requested' });
  await running;
  const saved = store.providers.get('connection');
  expect(saved.outcome).toBe('cancelled');
  expect(saved.verification).toBeUndefined();
});
