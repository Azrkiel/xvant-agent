import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { Orchestrator, type WorkerSpec } from './orchestrator.ts';
import { LiveTurnRunner } from './turn-runner.ts';

const fixture = (name: string) =>
  fileURLToPath(new URL('../../../tests/fixtures/' + name, import.meta.url));

/**
 * Offline G06 scenario: a three-node plan, one node per runtime, runs through
 * the real orchestrator, live controllers, worktrees, host verification and
 * serial integration, with synthetic runtime peers in place of models.
 */
export async function runOrchestrationFixture(root: string) {
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
        ...args,
      ],
      // Git's CRLF warnings would corrupt the fixture's JSON report.
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const store = new Store(join(root, 'state.sqlite'), { owner: 'fixture' });
  const objects = new ArtifactStore(join(root, 'objects'));
  const workers: WorkerSpec[] = [
    {
      alias: 'codex-1',
      runtimeKind: 'codex',
      quotaGroupId: 'chatgpt',
      roles: ['worker'],
    },
    {
      alias: 'claude-1',
      runtimeKind: 'claude',
      quotaGroupId: 'claude',
      roles: ['worker', 'reviewer'],
    },
    {
      alias: 'opencode-1',
      runtimeKind: 'opencode',
      quotaGroupId: 'free',
      roles: ['worker'],
    },
  ];
  try {
    const runner = new LiveTurnRunner(
      store,
      objects,
      workers,
      {
        codex: {
          executable: process.execPath,
          prefixArgs: [fixture('codex-live-peer.mjs'), 'write'],
        },
        claude: {
          executable: process.execPath,
          prefixArgs: [fixture('claude-live-peer.mjs'), 'write'],
        },
        opencode: {
          executable: process.execPath,
          prefixArgs: [fixture('opencode-cli.mjs'), 'tools'],
        },
      },
      { timeoutMs: 30000 },
    );
    const node = (id: string, assignee: string, dependsOn: string[] = []) => ({
      id,
      title: id,
      objective:
        'Create a file named ' +
        id +
        '.txt in the current directory whose entire content is the single line: ' +
        id +
        ' ok. Do not change anything else.',
      acceptanceCriteria: [id + '.txt exists'],
      assignee,
      dependsOn,
      writablePaths: [id + '.txt'],
    });
    const state = await new Orchestrator(store, runner, workers, {
      stateRoot: join(root, 'runs'),
    }).run({
      id: 'fixture',
      projectId: 'fixture',
      repository: repo,
      baseRevision: 'main',
      objective: 'Create three files, the last after the first two',
      acceptanceCriteria: ['all exist'],
      checks: {
        files: {
          executable: process.execPath,
          args: [
            '-e',
            "for(const f of ['a','b','c'])require('node:fs').readFileSync(f+'.txt')",
          ],
        },
      },
      plan: {
        summary: 'fixture',
        nodes: [
          node('a', '@codex-1'),
          node('b', '@opencode-1'),
          node('c', '@claude-1', ['a', 'b']),
        ],
      },
    });
    const events = store.graphs.events('fixture').map((e) => e.kind);
    return {
      classification: 'offline' as const,
      liveProvidersTested: [] as string[],
      phase: state.phase,
      reason: state.reason ?? null,
      nodes: Object.fromEntries(
        Object.entries(state.nodes).map(([id, n]) => [
          id,
          { status: n.status, aliases: n.attempts.map((a) => a.alias) },
        ]),
      ),
      combined: ['a', 'b', 'c'].every((f) =>
        existsSync(join(state.integration!.path, f + '.txt')),
      ),
      userCheckoutUntouched: !existsSync(join(repo, 'a.txt')),
      checks: state.checks.map((c) => c.status),
      reviewer: state.review?.alias ?? null,
      events,
      dependencyOrder:
        events.indexOf('node.integrated') <
        events.lastIndexOf('node.dispatched'),
    };
  } finally {
    store.close();
  }
}
