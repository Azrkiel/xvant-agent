import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import type { ProviderKind } from '../../../packages/contracts/src/providers.ts';
import {
  Orchestrator,
  type RootState,
  type WorkerSpec,
} from './orchestrator.ts';
import { LiveTurnRunner } from './turn-runner.ts';
import type { LiveEvent } from './codex-live.ts';
import type { RosterRuntime } from './live-roster.ts';

const FILES: Record<string, string> = {
  'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
  'server/greet.mjs':
    "export function greet(name) {\n  return 'Hello, ' + name + '!';\n}\n",
  'web/format.mjs':
    "export function banner(text) {\n  return '== ' + text + ' ==';\n}\n",
  'README.md':
    '# Fixture\n\n## API\n\n- `greet(name)` in server/greet.mjs\n- `banner(text)` in web/format.mjs\n',
};
const CHECK = `
const { greet, farewell } = await import('./server/greet.mjs');
const { banner, shout } = await import('./web/format.mjs');
const fail = (m) => { console.error(m); process.exit(1); };
if (greet('Ada') !== 'Hello, Ada!') fail('greet changed');
if (typeof farewell !== 'function' || farewell('Ada') !== 'Goodbye, Ada!') fail('farewell');
if (banner('x') !== '== x ==') fail('banner changed');
if (typeof shout !== 'function' || shout('hi there') !== 'HI THERE!') fail('shout');
const readme = (await import('node:fs')).readFileSync('README.md', 'utf8');
if (!readme.includes('farewell') || !readme.includes('shout')) fail('README');
`;
export interface LiveParallelReport {
  classification: 'live';
  scope: 'live-parallel-feature';
  phase: RootState['phase'];
  reason: string | null;
  plan: {
    id: string;
    assignee: string;
    dependsOn: string[];
    writablePaths: string[];
  }[];
  workersUsed: string[];
  runtimesUsed: string[];
  reviewer: { alias: string; approve: boolean; findings: string[] } | null;
  checks: string[];
  branch: string | null;
  userCheckoutUntouched: boolean;
  events: string[];
  problems: string[];
}

/**
 * Live G06: a real planner splits a separable feature, workers on different
 * runtimes build the parts in isolated worktrees, the host integrates their
 * patches one at a time, verifies the combined revision, and a reviewer on
 * an independent runtime reviews it. The user's checkout is never touched.
 */
export async function runLiveParallel(
  root: string,
  options: {
    runtimes: Partial<Record<ProviderKind, RosterRuntime>>;
    timeoutMs?: number;
    onEvent?: (alias: string, event: LiveEvent) => void;
    onChange?: (state: RootState, kind: string) => void;
  },
): Promise<LiveParallelReport> {
  const repo = join(root, 'repo');
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
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
    ).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const store = new Store(join(root, 'state.sqlite'), {
    owner: 'live-parallel',
  });
  const objects = new ArtifactStore(join(root, 'objects'));
  const workers: WorkerSpec[] = [
    {
      alias: 'codex-1',
      runtimeKind: 'codex',
      quotaGroupId: 'codex-subscription',
      roles: ['planner', 'worker', 'reviewer'],
    },
    {
      alias: 'claude-1',
      runtimeKind: 'claude',
      quotaGroupId: 'claude-subscription',
      roles: ['worker', 'reviewer'],
    },
    {
      alias: 'claude-2',
      runtimeKind: 'claude',
      quotaGroupId: 'claude-subscription',
      roles: ['reviewer'],
    },
    {
      alias: 'opencode-1',
      runtimeKind: 'opencode',
      quotaGroupId: 'opencode-free',
      roles: ['worker'],
    },
  ];
  const problems: string[] = [];
  try {
    const runner = new LiveTurnRunner(
      store,
      objects,
      workers,
      options.runtimes,
      {
        timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
        onEvent: (alias, _taskId, event) => options.onEvent?.(alias, event),
      },
    );
    const state = await new Orchestrator(store, runner, workers, {
      stateRoot: join(root, 'runs'),
      ...(options.onChange ? { onChange: options.onChange } : {}),
    }).run({
      id: 'feature',
      projectId: 'live-parallel',
      repository: repo,
      baseRevision: 'main',
      objective:
        "Add two functions and document them. In server/greet.mjs add and export farewell(name) returning 'Goodbye, <name>!'. In web/format.mjs add and export shout(text) returning text uppercased followed by '!'. Then list both new functions in the API section of README.md. Keep the existing functions unchanged. Treat the server change, the web change and the README update as three separate tasks for different workers; the README task comes after the other two.",
      acceptanceCriteria: [
        "farewell('Ada') returns 'Goodbye, Ada!'",
        "shout('hi there') returns 'HI THERE!'",
        'README.md lists farewell and shout',
        'greet and banner behave as before',
      ],
      checks: {
        behaviour: {
          executable: process.execPath,
          args: ['--input-type=module', '-e', CHECK],
        },
      },
      maxActive: 3,
    });
    const used = Object.values(state.nodes).flatMap((n) =>
      n.attempts.map((a) => a.alias),
    );
    const runtimesUsed = [
      ...new Set(
        used.map((a) => workers.find((w) => w.alias === a)!.runtimeKind),
      ),
    ];
    const report: LiveParallelReport = {
      classification: 'live',
      scope: 'live-parallel-feature',
      phase: state.phase,
      reason: state.reason ?? null,
      plan: (state.plan?.nodes ?? []).map((n) => ({
        id: n.id,
        assignee: n.assignee,
        dependsOn: n.dependsOn,
        writablePaths: n.writablePaths,
      })),
      workersUsed: [...new Set(used)],
      runtimesUsed,
      reviewer: state.review,
      checks: state.checks.map((c) => c.id + ':' + c.status),
      branch: state.integration?.branch ?? null,
      userCheckoutUntouched:
        git('status', '--porcelain') === '' &&
        !existsSync(join(repo, 'server', 'farewell.mjs')),
      events: store.graphs.events('feature').map((e) => e.kind),
      problems,
    };
    if (state.phase !== 'ready')
      problems.push('Root ended ' + state.phase + ': ' + (state.reason ?? ''));
    if (report.plan.length < 2)
      problems.push('The planner did not split the separable feature');
    if (runtimesUsed.length < 2)
      problems.push('Work did not span two runtimes');
    if (!state.checks.length || state.checks.some((c) => c.status !== 'passed'))
      problems.push('Combined checks did not pass');
    if (
      !state.review ||
      state.review.alias === 'none' ||
      !state.review.independent
    )
      problems.push('No independent review');
    if (!report.userCheckoutUntouched) problems.push('User checkout changed');
    return report;
  } finally {
    store.close();
  }
}
