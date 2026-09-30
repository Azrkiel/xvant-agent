import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolReceipt } from '../../../packages/contracts/src/tools.ts';
import type { ProviderKind } from '../../../packages/contracts/src/providers.ts';
import { LIVE_ROUTES } from '../../../packages/contracts/src/live.ts';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { createWorktree } from '../../../packages/storage/src/git-workspace.ts';
import { ToolRegistry } from '../../../packages/tools/src/registry.ts';
import { fileRead } from '../../../packages/tools/src/files.ts';
import { repoSearch } from '../../../packages/tools/src/repository.ts';
import { startMcpBridge } from '../../../packages/tools/src/mcp.ts';
import { LiveCodexController, type LiveEvent } from './codex-live.ts';
import { LiveClaudeController } from './claude-live.ts';
import { LiveOpenCodeController } from './opencode-live.ts';
import type { RosterRuntime } from './live-roster.ts';

export interface LiveMcpTurn {
  runtimeKind: ProviderKind;
  state: string;
  outcome: string | null;
  verification: string | null;
  receipts: { tool: string; status: string; code?: string }[];
  problems: string[];
}
export interface LiveMcpReport {
  classification: 'live';
  scope: 'live-mcp';
  turns: LiveMcpTurn[];
  problems: string[];
}

/**
 * Live G05: each runtime reaches XVANT's tools only through a task-scoped,
 * authenticated MCP bridge. The value it must deliver sits in the bridge's
 * workspace, which is not the worker's worktree and whose path is never given
 * to it, so passing requires a real `file_read` call through the bridge; the
 * registry's receipt records it. Uncataloged tools stay unlisted.
 */
export async function runLiveMcp(
  root: string,
  options: {
    runtimes: Partial<Record<ProviderKind, RosterRuntime>>;
    kinds?: ProviderKind[];
    timeoutMs?: number;
    onEvent?: (alias: string, event: LiveEvent) => void;
  },
): Promise<LiveMcpReport> {
  const kinds = options.kinds ?? ['codex', 'claude', 'opencode'];
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=xvant',
        '-c',
        'user.email=xvant@local.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8', windowsHide: true },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# MCP fixture\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const store = new Store(join(root, 'state.sqlite'), { owner: 'live-mcp' });
  const objects = new ArtifactStore(join(root, 'objects'));
  const turns: LiveMcpTurn[] = [];
  try {
    for (const kind of kinds) {
      const spec = options.runtimes[kind];
      if (!spec) throw new Error('RUNTIME_UNAVAILABLE: ' + kind);
      const alias = kind + '-mcp';
      const taskId = alias + '-t1';
      const nonce = 'XVANT-' + randomBytes(6).toString('hex');
      const bridgeRoot = join(root, 'bridge-' + kind);
      mkdirSync(bridgeRoot, { recursive: true });
      writeFileSync(join(bridgeRoot, 'plan.txt'), nonce + '\n');
      const tree = createWorktree(
        repo,
        'main',
        join(root, 'wt', alias),
        'xvant/' + alias,
      );
      const receipts: ToolReceipt[] = [];
      const registry = new ToolRegistry([fileRead, repoSearch], {
        record: (receipt) => receipts.push(receipt),
      });
      store.create('create-' + taskId, {
        id: taskId,
        projectId: 'mcp',
        objective:
          'Use the file_read tool from the MCP server named xvant to read the file plan.txt. Then create a file named answer.txt in the current directory whose entire content is exactly the text that tool returned, trimmed, on a single line. Do not look for plan.txt on disk and do not change anything else.',
        requiredCheckIds: ['check'],
        acceptanceCriteria: ['answer.txt holds the value from the XVANT tool'],
      });
      store.queue('queue-' + taskId, taskId, 0);
      const bridge = await startMcpBridge({
        registry,
        context: {
          projectId: 'mcp',
          taskId,
          attemptId: taskId + '-a1',
          workerId: alias,
          permissionProfile: 'trusted-local',
          allowedTools: ['file.read', 'repo.search'],
          approvals: [],
          now: () => Date.now(),
          workspace: { root: realpathSync(bridgeRoot), writablePaths: [] },
        },
      });
      const route = LIVE_ROUTES[kind];
      const common = {
        executable: spec.executable,
        prefixArgs: spec.prefixArgs ?? [],
        timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
        gitBases: { [alias]: tree.baseCommit },
        mcp: {
          url: bridge.url,
          token: bridge.token,
          tools: ['file.read', 'repo.search'],
        },
        onEvent: (event: LiveEvent) => options.onEvent?.(alias, event),
      };
      const workspaces = { [alias]: tree.path };
      const checks = {
        check: {
          executable: process.execPath,
          args: [
            '-e',
            `if(require('node:fs').readFileSync('answer.txt','utf8').trim()!==${JSON.stringify(nonce)})process.exit(1)`,
          ],
        },
      };
      const input = {
        connectionId: taskId,
        taskId,
        attemptId: taskId + '-a1',
        workspaceId: alias,
        expectedVersion: store.getTask(taskId).rowVersion,
        classification: 'live' as const,
        liveApproval: {
          actorId: 'operator',
          model:
            kind === 'opencode'
              ? 'opencode/big-pickle'
              : (spec.model ?? 'default'),
          transport: route.transport,
          userApprovedTrustedLocal: true as const,
          profile: 'workspace-write' as const,
          acknowledgedNativeBypass: true as const,
        },
        worker: {
          id: alias,
          alias,
          runtimeKind: kind,
          hostId: 'local',
          endpointId: route.transport,
          nativeSessionId:
            kind === 'claude' ? randomUUID() : 'pending:' + taskId,
          runtimeVersion: spec.version ?? route.runtimeVersion,
          adapterVersion: route.adapterVersion,
          mode: 'managed' as const,
          quotaGroupId: kind + '-subscription',
        },
      };
      try {
        if (kind === 'codex') {
          const c = new LiveCodexController(
            store,
            objects,
            workspaces,
            checks,
            common,
          );
          try {
            await c.run(input, 'create');
          } finally {
            c.stop();
          }
        } else if (kind === 'claude') {
          const c = new LiveClaudeController(
            store,
            objects,
            workspaces,
            checks,
            common,
          );
          try {
            await c.run(input, 'create');
          } finally {
            c.stop();
          }
        } else {
          const c = new LiveOpenCodeController(
            store,
            objects,
            workspaces,
            checks,
            common,
          );
          try {
            await c.runLive(input);
          } finally {
            c.stop();
          }
        }
      } finally {
        await bridge.close();
      }
      const saved = store.providers.get(taskId);
      const problems: string[] = [];
      const reads = receipts.filter(
        (r) => r.tool === 'file.read' && r.status === 'succeeded',
      );
      if (!reads.length)
        problems.push(kind + ': no file.read call reached the bridge');
      if (receipts.some((r) => r.taskId !== taskId || r.workerId !== alias))
        problems.push(kind + ': receipt outside the task scope');
      if (saved.verification?.status !== 'passed')
        problems.push(kind + ': the delivered value did not verify');
      turns.push({
        runtimeKind: kind,
        state: store.getTask(taskId).state,
        outcome: saved.outcome,
        verification: saved.verification?.status ?? null,
        receipts: receipts.map((r) => ({
          tool: r.tool,
          status: r.status,
          ...(r.code ? { code: r.code } : {}),
        })),
        problems,
      });
    }
  } finally {
    store.close();
  }
  return {
    classification: 'live',
    scope: 'live-mcp',
    turns,
    problems: turns.flatMap((t) => t.problems),
  };
}
