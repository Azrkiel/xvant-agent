import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { ArtifactStore } from '../../../packages/storage/src/artifacts.ts';
import { createWorktree } from '../../../packages/storage/src/git-workspace.ts';
import { LIVE_ROUTES } from '../../../packages/contracts/src/live.ts';
import type { ProviderKind } from '../../../packages/contracts/src/providers.ts';
import type { ProviderDispatch } from '../../../packages/storage/src/providers.ts';
import { NativeReviewController } from './native-review.ts';
import {
  LiveCodexController,
  type LiveEvent,
  type LiveRunResult,
} from './codex-live.ts';
import { LiveClaudeController } from './claude-live.ts';
import { LiveOpenCodeController } from './opencode-live.ts';

export interface RosterRuntime {
  executable: string;
  /** Fixture launchers only. */
  prefixArgs?: readonly string[];
  /** `default` or a model the runtime accepts. */
  model?: string;
}
export interface RosterOptions {
  runtimes: Record<ProviderKind, RosterRuntime>;
  counts?: Record<ProviderKind, number>;
  concurrency?: number;
  timeoutMs?: number;
  /** Explicit resume of one worker per runtime. */
  resume?: boolean;
  /** Interrupt one live turn per runtime. */
  interrupt?: boolean;
  onEvent?: (alias: string, event: LiveEvent) => void;
  now?: () => number;
}
export interface RosterTurn {
  alias: string;
  runtimeKind: ProviderKind;
  kind: 'initial' | 'resume' | 'interrupt';
  connectionId: string;
  state: string;
  status: string;
  outcome: string | null;
  sessionId: string;
  runId: string | null;
  verification: string | null;
  changedFiles: string[];
  accepted: boolean;
  tokens: number | null;
  auth: string | null;
  failure: string | null;
  elapsedMs: number;
}
export interface RosterReport {
  classification: 'live';
  scope: 'live-roster';
  counts: Record<ProviderKind, number>;
  concurrency: number;
  maxObservedConcurrency: number;
  turns: RosterTurn[];
  problems: string[];
  activeCount: number;
}
type Controller =
  LiveCodexController | LiveClaudeController | LiveOpenCodeController;

/**
 * The live G03 roster: named workers across the three runtimes, each in its
 * own Git worktree with its own task and session, run under a concurrency
 * cap. Every result is verified by the host and accepted explicitly after a
 * controller restart. Optional scenarios resume one session per runtime and
 * interrupt one live turn per runtime. Nothing retries automatically.
 */
export async function runLiveRoster(
  root: string,
  options: RosterOptions,
): Promise<RosterReport> {
  const counts = options.counts ?? { codex: 2, claude: 3, opencode: 5 };
  const concurrency = options.concurrency ?? 3;
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const now = options.now ?? Date.now;
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
    ).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# XVANT live roster fixture\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  const objects = new ArtifactStore(join(root, 'objects'));
  let store = new Store(join(root, 'state.sqlite'), { owner: 'live-roster' });
  const workers: {
    alias: string;
    kind: ProviderKind;
    path: string;
    base: string;
  }[] = [];
  for (const kind of ['codex', 'claude', 'opencode'] as const)
    for (let i = 1; i <= counts[kind]; i++) {
      const alias = kind + '-' + i;
      const tree = createWorktree(
        repo,
        'main',
        join(root, 'wt', alias),
        'xvant/' + alias,
      );
      workers.push({ alias, kind, path: tree.path, base: tree.baseCommit });
    }
  const turns: RosterTurn[] = [];
  const problems: string[] = [];
  const sessions = new Map<string, string>();
  const controllers = new Set<Controller>();
  let active = 0,
    maxActive = 0;
  const nonce = randomBytes(4).toString('hex');
  const check = (file: string, lines: string[]) => ({
    executable: process.execPath,
    args: [
      '-e',
      `const t=require('node:fs').readFileSync(${JSON.stringify(file)},'utf8').replace(/\\r\\n/g,'\\n').trim();if(t!==${JSON.stringify(lines.join('\n'))})process.exit(1)`,
    ],
  });
  const controllerFor = (
    worker: (typeof workers)[number],
    checks: Record<string, { executable: string; args: readonly string[] }>,
  ): Controller => {
    const runtime = options.runtimes[worker.kind];
    const common = {
      executable: runtime.executable,
      prefixArgs: runtime.prefixArgs ?? [],
      timeoutMs,
      gitBases: { [worker.alias]: worker.base },
      onEvent: (event: LiveEvent) => options.onEvent?.(worker.alias, event),
    };
    const workspaces = { [worker.alias]: worker.path };
    const controller =
      worker.kind === 'codex'
        ? new LiveCodexController(store, objects, workspaces, checks, common)
        : worker.kind === 'claude'
          ? new LiveClaudeController(store, objects, workspaces, checks, common)
          : new LiveOpenCodeController(
              store,
              objects,
              workspaces,
              checks,
              common,
            );
    controllers.add(controller);
    return controller;
  };
  const dispatch = (
    worker: (typeof workers)[number],
    taskId: string,
    session: string,
  ): ProviderDispatch => {
    const route = LIVE_ROUTES[worker.kind];
    return {
      connectionId: taskId,
      taskId,
      attemptId: taskId + '-a1',
      workspaceId: worker.alias,
      expectedVersion: store.getTask(taskId).rowVersion,
      classification: 'live',
      liveApproval: {
        actorId: 'operator',
        model:
          worker.kind === 'opencode'
            ? 'opencode/big-pickle'
            : (options.runtimes[worker.kind].model ?? 'default'),
        transport: route.transport,
        userApprovedTrustedLocal: true,
        profile: 'workspace-write',
        acknowledgedNativeBypass: true,
      },
      worker: {
        id: worker.alias,
        alias: worker.alias,
        runtimeKind: worker.kind,
        hostId: 'local',
        endpointId: route.transport,
        nativeSessionId: session,
        runtimeVersion: route.runtimeVersion,
        adapterVersion: route.adapterVersion,
        mode: 'managed',
        quotaGroupId: worker.kind + '-subscription',
      },
    };
  };
  const execute = async (
    worker: (typeof workers)[number],
    kind: RosterTurn['kind'],
    taskId: string,
    objective: string,
    expected: string[],
    during?: (
      controller: Controller,
      connectionId: string,
      settled: () => boolean,
    ) => Promise<void>,
  ) => {
    store.create('create-' + taskId, {
      id: taskId,
      projectId: 'live-roster',
      objective,
      requiredCheckIds: ['check'],
      acceptanceCriteria: ['The file has exactly the requested lines'],
    });
    store.queue('queue-' + taskId, taskId, 0);
    const controller = controllerFor(worker, {
      check: check(worker.alias + '.txt', expected),
    });
    const resuming = kind !== 'initial' && sessions.has(worker.alias);
    const session = resuming
      ? sessions.get(worker.alias)!
      : worker.kind === 'claude'
        ? randomUUID()
        : 'pending:' + taskId;
    const input = dispatch(worker, taskId, session);
    const started = now();
    active++;
    maxActive = Math.max(maxActive, active);
    let result: LiveRunResult | undefined;
    try {
      const running =
        controller instanceof LiveOpenCodeController
          ? controller.runLive(
              input,
              resuming ? previousConnection.get(worker.alias) : undefined,
            )
          : controller.run(input, resuming ? 'resume' : 'create');
      let settled = false;
      void running.then(
        () => (settled = true),
        () => (settled = true),
      );
      if (during) await during(controller, taskId, () => settled);
      result = await running;
    } catch (error) {
      problems.push(
        worker.alias + ' ' + kind + ': ' + (error as Error).message,
      );
    } finally {
      active--;
    }
    let saved;
    try {
      saved = store.providers.get(taskId);
    } catch {
      saved = undefined;
    }
    if (saved && kind !== 'interrupt')
      sessions.set(worker.alias, saved.worker.nativeSessionId);
    let changedFiles: string[] = [];
    if (saved?.verification && saved.verification.status !== 'unknown') {
      const manifest = JSON.parse(
        objects.get(saved.verification.evidence.treeHash).toString(),
      );
      changedFiles = (manifest.files ?? []).map(
        (f: { path: string }) => f.path,
      );
    }
    turns.push({
      alias: worker.alias,
      runtimeKind: worker.kind,
      kind,
      connectionId: taskId,
      state: store.getTask(taskId).state,
      status: saved?.status ?? 'not_reserved',
      outcome: saved?.outcome ?? null,
      sessionId: saved?.worker.nativeSessionId ?? session,
      runId: saved?.nativeRunId ?? null,
      verification: saved?.verification?.status ?? null,
      changedFiles,
      accepted: false,
      tokens: result?.tokens ?? null,
      auth: result?.auth ? result.auth.mode + '/' + result.auth.plan : null,
      failure: saved?.failure
        ? saved.failure.code + ':' + saved.failure.native
        : null,
      elapsedMs: now() - started,
    });
  };
  const previousConnection = new Map<string, string>();
  const acceptAll = (kind: RosterTurn['kind']) => {
    for (const c of controllers) c.stop();
    controllers.clear();
    store.close();
    store = new Store(join(root, 'state.sqlite'), { owner: 'live-roster' });
    const review = new NativeReviewController(store, objects);
    for (const turn of turns.filter(
      (t) => t.kind === kind && t.state === 'ready_for_acceptance',
    )) {
      const prepared = store
        .events(0)
        .find(
          (e) =>
            e.kind === 'native.ready_for_acceptance' &&
            (e.payload as { connectionId: string }).connectionId ===
              turn.connectionId,
        )?.payload as { rowVersion: number; evidenceHash: string } | undefined;
      if (!prepared) continue;
      const accepted = review.accept('accept-' + turn.connectionId, {
        connectionId: turn.connectionId,
        expectedVersion: prepared.rowVersion,
        reviewedEvidenceHash: prepared.evidenceHash,
        actorId: 'roster-reviewer',
        classification: 'live',
      });
      turn.accepted = accepted.state === 'accepted';
      turn.state = accepted.state;
      previousConnection.set(turn.alias, turn.connectionId);
    }
  };
  const pool = async <T>(items: T[], run: (item: T) => Promise<void>) => {
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let item = queue.shift(); item; item = queue.shift())
          await run(item);
      }),
    );
  };
  try {
    await pool(workers, (worker) =>
      execute(
        worker,
        'initial',
        worker.alias + '-t1',
        'Create a file named ' +
          worker.alias +
          '.txt in the current directory whose entire content is the single line: ' +
          worker.alias +
          ' ' +
          nonce +
          '. Do not create, change or commit anything else.',
        [worker.alias + ' ' + nonce],
      ),
    );
    acceptAll('initial');
    const firsts = (['codex', 'claude', 'opencode'] as const)
      .map((kind) =>
        workers.find(
          (w) =>
            w.kind === kind &&
            turns.some((t) => t.alias === w.alias && t.accepted),
        ),
      )
      .filter((w): w is (typeof workers)[number] => !!w);
    if (options.resume)
      await pool(firsts, (worker) =>
        execute(
          worker,
          'resume',
          worker.alias + '-t2',
          'In ' +
            worker.alias +
            '.txt, keep the existing line and add a second line: resumed ' +
            nonce +
            '. Do not change anything else.',
          [worker.alias + ' ' + nonce, 'resumed ' + nonce],
        ),
      );
    acceptAll('resume');
    if (options.interrupt)
      await pool(firsts, (worker) =>
        execute(
          worker,
          'interrupt',
          worker.alias + '-t3',
          'Create 40 files named step_01.txt through step_40.txt one at a time, each containing its own number, running a separate command for each file. Then list them.',
          ['never'],
          async (controller, id, settled) => {
            for (let i = 0; i < 2400 && !settled(); i++) {
              await new Promise((r) => setTimeout(r, 250));
              try {
                controller.interrupt(id, 'roster-operator');
                return;
              } catch {
                /* not yet interruptible */
              }
            }
          },
        ),
      );
    for (const turn of turns.filter(
      (t) => t.kind === 'interrupt' && t.outcome === 'cancelled',
    ))
      store.providers.reconcile(turn.connectionId, 'stopped');
  } finally {
    for (const c of controllers) c.stop();
  }
  const activeCount = [...controllers].reduce((n, c) => n + c.activeCount, 0);
  store.close();
  problems.push(...rosterProblems({ counts, turns }));
  return {
    classification: 'live',
    scope: 'live-roster',
    counts,
    concurrency,
    maxObservedConcurrency: maxActive,
    turns,
    problems,
    activeCount,
  };
}

/** Every violated roster expectation; empty when the roster passed. */
export function rosterProblems(report: {
  counts: Record<ProviderKind, number>;
  turns: RosterTurn[];
}): string[] {
  const problems: string[] = [];
  const initial = report.turns.filter((t) => t.kind === 'initial');
  const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
  if (initial.length !== total) problems.push('missing roster turns');
  if (new Set(initial.map((t) => t.sessionId)).size !== initial.length)
    problems.push('sessions are not distinct');
  for (const turn of initial) {
    if (!turn.accepted) problems.push(turn.alias + ' was not accepted');
    if (
      JSON.stringify(turn.changedFiles) !==
      JSON.stringify([turn.alias + '.txt'])
    )
      problems.push(
        turn.alias + ' changed ' + JSON.stringify(turn.changedFiles),
      );
  }
  for (const turn of report.turns.filter((t) => t.kind === 'resume')) {
    const first = initial.find((t) => t.alias === turn.alias);
    if (!turn.accepted) problems.push(turn.alias + ' resume was not accepted');
    if (first && first.sessionId !== turn.sessionId)
      problems.push(turn.alias + ' resume used another session');
  }
  for (const turn of report.turns.filter((t) => t.kind === 'interrupt'))
    if (turn.outcome !== 'cancelled')
      problems.push(turn.alias + ' interrupt ended ' + turn.outcome);
  return problems;
}
