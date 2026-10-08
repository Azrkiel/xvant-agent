import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Store } from '../packages/storage/src/store.ts';
import { ArtifactStore } from '../packages/storage/src/artifacts.ts';
import { captureGitWorkspace } from '../packages/storage/src/git-workspace.ts';
import {
  Orchestrator,
  type RootState,
  type TurnOutcome,
  type TurnRequest,
  type TurnRunner,
  type WorkerSpec,
} from '../apps/controller/src/orchestrator.ts';

// Offline soak: the real orchestrator, store, worktrees, integration branch
// and host checks against throwaway Git repositories, with a fake turn runner
// that injects faults from a seeded generator. No model is ever called.

export const SCENARIOS = [
  'clean',
  'turn_failure_transient',
  'turn_failure_persistent',
  'unknown_outcome',
  'conflicting_patches',
  'check_failure_fixed',
  'check_failure_unfixed',
  'review_reject_fixed',
  'review_reject_standing',
  'review_fix_unknown',
] as const;
export type Scenario = (typeof SCENARIOS)[number];
const WEIGHTS: Record<Scenario, number> = {
  clean: 2,
  turn_failure_transient: 2,
  turn_failure_persistent: 1,
  unknown_outcome: 2,
  conflicting_patches: 2,
  check_failure_fixed: 1,
  check_failure_unfixed: 1,
  review_reject_fixed: 1,
  review_reject_standing: 1,
  review_fix_unknown: 1,
};
const TERMINAL = new Set(['ready', 'failed', 'needs_attention', 'cancelled']);
// What the orchestrator must reach for each injected fault.
const EXPECTED_PHASE: Record<Scenario, string> = {
  clean: 'ready',
  turn_failure_transient: 'ready',
  turn_failure_persistent: 'failed',
  unknown_outcome: 'needs_attention',
  conflicting_patches: 'ready',
  check_failure_fixed: 'ready',
  check_failure_unfixed: 'failed',
  review_reject_fixed: 'ready',
  review_reject_standing: 'ready',
  review_fix_unknown: 'needs_attention',
};
/** Growth beyond this factor after warm-up is flagged, once it is also this many bytes. */
export const RSS_FACTOR = 1.5;
export const RSS_FLOOR_BYTES = 64 * 1024 * 1024;
const ITERATION_TIMEOUT_MS = 3 * 60 * 1000;

/** mulberry32: a small seeded generator; the same seed gives the same scenarios. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(random: () => number): Scenario {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  let n = random() * total;
  for (const name of SCENARIOS) {
    n -= WEIGHTS[name];
    if (n < 0) return name;
  }
  return SCENARIOS[0];
}

const workers: WorkerSpec[] = [
  {
    alias: 'codex-1',
    runtimeKind: 'codex',
    quotaGroupId: 'chatgpt',
    roles: ['planner', 'worker'],
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
const check = {
  all: {
    executable: process.execPath,
    args: [
      '-e',
      "const fs=require('node:fs');for(const f of ['a.txt','b.txt','c.txt'])fs.readFileSync(f);if(fs.existsSync('poison.txt'))process.exit(1)",
    ],
  },
};
// The conflicting scenario's workers also edit README.md, outside the scope the
// plan gives them, as a misbehaving runtime could; the plan itself stays valid.
const node = (id: string, dependsOn: string[] = []) => ({
  id,
  title: id,
  objective: 'write ' + id + '.txt',
  acceptanceCriteria: [id + '.txt exists'],
  dependsOn,
  writablePaths: [id + '.txt'],
});
const buildPlan = (scenario: Scenario) => ({
  summary: 'soak ' + scenario,
  nodes: [node('a'), node('b'), node('c', ['a', 'b'])],
});

interface Call {
  label: string;
  attempt: number;
  status: TurnOutcome['status'];
}
/** Edits the real worktree and returns its real patch, like a live runner. */
class SoakRunner implements TurnRunner {
  readonly calls: Call[] = [];
  readonly scenario: Scenario;
  readonly prefix: string;
  readonly objects: ArtifactStore;
  readonly jitter: () => number;
  readonly count = new Map<string, number>();
  constructor(
    scenario: Scenario,
    prefix: string,
    objects: ArtifactStore,
    jitter: () => number,
  ) {
    this.scenario = scenario;
    this.prefix = prefix;
    this.objects = objects;
    this.jitter = jitter;
  }
  interrupt() {
    return true;
  }
  async run(request: TurnRequest): Promise<TurnOutcome> {
    const label = request.taskId.slice(
      this.prefix.length + 1,
      request.taskId.lastIndexOf('-'),
    );
    const attempt = (this.count.get(label) ?? 0) + 1;
    this.count.set(label, attempt);
    await new Promise((r) => setTimeout(r, Math.floor(this.jitter() * 15)));
    const path = (file: string) => join(request.workspace.path, file);
    const write = (file: string, text: string) =>
      writeFileSync(path(file), text);
    const s = this.scenario;
    let status: TurnOutcome['status'] = 'accepted';
    let failure: string | undefined;
    let finalText = 'done';
    if (label === 'review') {
      const reject =
        s === 'review_reject_standing' ||
        s === 'review_fix_unknown' ||
        (s === 'review_reject_fixed' && attempt === 1);
      finalText =
        '```json\n' +
        JSON.stringify(
          reject
            ? { approve: false, findings: ['needs a changelog entry'] }
            : { approve: true, findings: [] },
        ) +
        '\n```';
    } else if (label === 'review-fix') {
      if (s === 'review_fix_unknown') status = 'unknown';
      else if (s === 'review_reject_fixed') write('CHANGELOG.md', 'fixed\n');
    } else if (label === 'fix') {
      if (s === 'check_failure_fixed')
        rmSync(path('poison.txt'), { force: true });
    } else {
      write(label + '.txt', label + ' ok\n');
      if (s === 'conflicting_patches' && label !== 'c') {
        if (attempt === 1) write('README.md', 'from ' + label + '\n');
        else
          write(
            'README.md',
            readFileSync(path('README.md'), 'utf8') + label + ' again\n',
          );
      }
      if (label === 'b') {
        if (s === 'turn_failure_transient' && attempt === 1) {
          status = 'failed';
          failure = 'worker crashed (transient)';
        }
        if (s === 'turn_failure_persistent') {
          status = 'failed';
          failure = 'worker crashed (persistent)';
        }
        if (s === 'unknown_outcome' && attempt === 1) status = 'unknown';
        if (
          (s === 'check_failure_fixed' || s === 'check_failure_unfixed') &&
          attempt === 1
        )
          write('poison.txt', 'bad\n');
      }
    }
    this.calls.push({ label, attempt, status });
    if (status === 'unknown')
      return { status, finalText: '', patch: null, files: [] };
    const snap = captureGitWorkspace(
      request.workspace.path,
      request.workspace.baseCommit,
      this.objects,
    );
    const manifest = JSON.parse(this.objects.get(snap.treeHash).toString());
    return {
      status,
      finalText,
      patch: this.objects.get(manifest.patch),
      files: manifest.files.map((f: { path: string }) => f.path),
      ...(failure ? { failure } : {}),
    };
  }
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=soak', '-c', 'user.email=soak@local.invalid', ...args],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
const checkout = (repo: string) => ({
  head: gitIn(repo, 'rev-parse', 'HEAD'),
  branch: gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
  status: gitIn(repo, 'status', '--porcelain'),
  branches: gitIn(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/')
    .split('\n')
    .filter((r) => !/^refs\/heads\/xvant(-work)?\//.test(r))
    .join(','),
  files: readdirSync(repo)
    .filter((n) => n !== '.git')
    .sort()
    .join(','),
});
const samePath = (a: string, b: string) =>
  resolve(a).toLowerCase() === resolve(b).toLowerCase();
const patchLeftovers = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith('xvant-patch-')).length;

export interface SoakReport {
  seed: number;
  requestedMinutes: number | null;
  durationMs: number;
  iterations: number;
  scenarioCounts: Record<string, number>;
  /** Faults seen by the orchestrator, counted from its own events. */
  faultCounts: Record<string, number>;
  phaseCounts: Record<string, number>;
  memory: {
    firstRss: number;
    lastRss: number;
    maxRss: number;
    warmupIterations: number;
    baselineRss: number;
    maxFactorAfterWarmup: number;
    allowedFactor: number;
    floorBytes: number;
  };
  /** Longest stretch in which no timer ran; at or above the store lease, the lease was lost. */
  maxTimerGapMs: number;
  violations: string[];
}

export async function runSoak(options: {
  seed: number;
  minutes?: number;
  maxIterations?: number;
  log?: (line: string) => void;
}): Promise<SoakReport> {
  const log = options.log ?? (() => {});
  const random = seeded(options.seed);
  const started = Date.now();
  const deadline = started + (options.minutes ?? 0) * 60000;
  const master = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-soak-')));
  const store = new Store(join(master, 'state.sqlite'), { owner: 'soak' });
  // The orchestrator renews the store lease while it runs. Between runs the
  // soak holds it the way the app does, with its own timer. The timer also
  // measures how long the process went without running timers: a gap longer
  // than the lease means the host or a blocking call stalled it.
  let lastBeat = Date.now();
  let maxTimerGapMs = 0;
  const beat = setInterval(() => {
    const now = Date.now();
    maxTimerGapMs = Math.max(maxTimerGapMs, now - lastBeat);
    lastBeat = now;
    try {
      store.heartbeat();
    } catch {
      /* A lost lease surfaces as a failed iteration. */
    }
  }, 1000);
  const objects = new ArtifactStore(join(master, 'objects'));
  const violations: string[] = [];
  const scenarioCounts: Record<string, number> = {};
  const faultCounts: Record<string, number> = {
    turn_failure: 0,
    unknown_outcome: 0,
    integration_conflict: 0,
    check_failure: 0,
    review_rejection: 0,
  };
  const phaseCounts: Record<string, number> = {};
  const rss: number[] = [];
  const patchBaseline = patchLeftovers();
  let iterations = 0;
  try {
    while (
      (options.minutes === undefined || Date.now() < deadline) &&
      (options.maxIterations === undefined ||
        iterations < options.maxIterations)
    ) {
      const n = iterations++;
      const scenario = pick(random);
      scenarioCounts[scenario] = (scenarioCounts[scenario] ?? 0) + 1;
      const where = 'iteration ' + n + ' (' + scenario + '): ';
      const problems: string[] = [];
      const dir = join(master, 'i' + n);
      const repo = join(dir, 'repo');
      const runs = join(dir, 'runs');
      mkdirSync(repo, { recursive: true });
      gitIn(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      gitIn(repo, 'add', '.');
      gitIn(repo, 'commit', '-qm', 'base');
      const before = checkout(repo);
      const id = 'soak-' + n;
      const runner = new SoakRunner(scenario, id, objects, random);
      const orchestrator = new Orchestrator(store, runner, workers, {
        stateRoot: runs,
      });
      let state: RootState | undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        state = await Promise.race([
          orchestrator.run({
            id,
            projectId: 'soak',
            repository: repo,
            baseRevision: 'main',
            objective: 'soak ' + scenario,
            acceptanceCriteria: ['a, b and c exist'],
            checks: check,
            plan: buildPlan(scenario),
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('iteration timed out')),
              ITERATION_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (error) {
        problems.push('run threw: ' + (error as Error).message);
        // A run that timed out is still going; stop it before its directory goes.
        orchestrator.cancel();
      } finally {
        clearTimeout(timer);
      }
      if (state) {
        phaseCounts[state.phase] = (phaseCounts[state.phase] ?? 0) + 1;
        const events = store.graphs.events(id);
        // 1. A terminal phase, and the one the injected fault calls for.
        if (!TERMINAL.has(state.phase))
          problems.push('ended in non-terminal phase ' + state.phase);
        else if (state.phase !== EXPECTED_PHASE[scenario])
          problems.push(
            'phase ' +
              state.phase +
              ', expected ' +
              EXPECTED_PHASE[scenario] +
              (state.reason ? ' (' + state.reason + ')' : ''),
          );
        if (
          scenario === 'review_reject_standing' &&
          (state.review?.approve ?? true)
        )
          problems.push('a standing rejection was recorded as approved');
        if (scenario === 'review_reject_fixed' && !state.review?.approve)
          problems.push('the repaired result was not approved');
        // 2. An unknown outcome is never retried or re-dispatched.
        const unknown = runner.calls.filter((c) => c.status === 'unknown');
        for (const u of unknown) {
          const later = runner.calls.filter(
            (c) => c.label === u.label && c.attempt > u.attempt,
          );
          if (later.length)
            problems.push('unknown outcome of ' + u.label + ' was retried');
          if (u.label === 'fix' || u.label === 'review-fix') {
            const index = runner.calls.indexOf(u);
            if (index !== runner.calls.length - 1)
              problems.push(
                'a turn ran after the unknown ' + u.label + ' turn',
              );
          }
        }
        for (const [nodeId, entry] of Object.entries(state.nodes)) {
          const at = entry.attempts.findIndex((a) => a.status === 'unknown');
          if (at >= 0 && (at !== entry.attempts.length - 1 || entry.repairs))
            problems.push('node ' + nodeId + ' continued after an unknown');
          if (at >= 0 && entry.status !== 'needs_attention')
            problems.push(
              'node ' + nodeId + ' with unknown is ' + entry.status,
            );
        }
        if (unknown.length === 0 && scenario.includes('unknown'))
          problems.push('the unknown outcome was never injected');
        // A scenario that ends ready proves nothing unless its fault happened.
        type Seen = { checks?: { status: string }[]; approve?: boolean };
        const saw = (
          kind: string,
          test: (payload: Seen) => unknown = () => true,
        ) => events.some((e) => e.kind === kind && !!test(e.payload as Seen));
        if (
          scenario.startsWith('check_failure') &&
          !saw('graph.checked', (p) =>
            p.checks?.some((c) => c.status === 'failed'),
          )
        )
          problems.push('the failing check was never seen');
        if (
          scenario.startsWith('turn_failure') &&
          !runner.calls.some((c) => c.status === 'failed')
        )
          problems.push('the turn failure was never injected');
        if (
          scenario.startsWith('review_') &&
          !saw('graph.reviewed', (p) => p.approve === false)
        )
          problems.push('the rejecting review was never seen');
        if (scenario.startsWith('review_') && !saw('graph.review_fix'))
          problems.push('the review repair never ran');
        // Faults as the orchestrator saw them.
        for (const call of runner.calls) {
          if (call.status === 'failed') faultCounts.turn_failure!++;
          if (call.status === 'unknown') faultCounts.unknown_outcome!++;
        }
        for (const e of events) {
          const payload = e.payload as {
            reason?: string;
            checks?: { status: string }[];
            approve?: boolean;
          };
          if (
            e.kind === 'node.repair' &&
            payload.reason?.startsWith('Integration conflict')
          )
            faultCounts.integration_conflict!++;
          if (
            e.kind === 'graph.checked' &&
            payload.checks?.some((c) => c.status === 'failed')
          )
            faultCounts.check_failure!++;
          if (e.kind === 'graph.reviewed' && payload.approve === false)
            faultCounts.review_rejection!++;
        }
        if (
          scenario === 'conflicting_patches' &&
          !events.some(
            (e) =>
              e.kind === 'node.repair' &&
              String((e.payload as { reason?: string }).reason).startsWith(
                'Integration conflict',
              ),
          )
        )
          problems.push('no integration conflict was observed');
      }
      // 3. The user's checkout is exactly as it was.
      const after = checkout(repo);
      for (const key of Object.keys(before) as (keyof typeof before)[])
        if (before[key] !== after[key])
          problems.push("the user's checkout changed: " + key);
      // 4. Only what the run owns is left behind.
      const owned = join(runs, id);
      for (const line of gitIn(repo, 'worktree', 'list', '--porcelain').split(
        '\n',
      ))
        if (line.startsWith('worktree ')) {
          const path = line.slice('worktree '.length);
          if (
            !samePath(path, repo) &&
            !(resolve(path) + sep)
              .toLowerCase()
              .startsWith((owned + sep).toLowerCase())
          )
            problems.push('worktree outside the run: ' + path);
        }
      for (const ref of gitIn(
        repo,
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads/',
      ).split('\n'))
        if (
          ref !== 'refs/heads/main' &&
          !ref.startsWith('refs/heads/xvant/' + id) &&
          !ref.startsWith('refs/heads/xvant-work/' + id + '/')
        )
          problems.push('unexpected branch ' + ref);
      if (existsSync(runs) && readdirSync(runs).join() !== id)
        problems.push(
          'state root holds more than the run: ' + readdirSync(runs).join(),
        );
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      if (existsSync(dir))
        problems.push('iteration directory was not removable');
      if (patchLeftovers() > patchBaseline)
        problems.push('integration patch file left in the temp directory');
      rss.push(process.memoryUsage().rss);
      for (const p of problems) violations.push(where + p);
      log(
        where +
          (state?.phase ?? 'no result') +
          (problems.length ? ' VIOLATION ' + problems.join('; ') : '') +
          '  rss ' +
          Math.round(rss.at(-1)! / 1048576) +
          ' MB  timer gap ' +
          maxTimerGapMs +
          ' ms',
      );
    }
  } finally {
    clearInterval(beat);
    store.close();
    rmSync(master, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
  if (existsSync(master)) violations.push('soak directory was not removable');
  // 5. Memory: judged against the level after warm-up.
  const warmup = Math.min(rss.length, Math.max(3, Math.ceil(rss.length * 0.1)));
  const after = rss.slice(warmup);
  const baseline = rss[warmup - 1] ?? 0;
  const peak = after.length ? Math.max(...after) : baseline;
  const factor = baseline ? peak / baseline : 1;
  if (
    after.length >= 3 &&
    factor > RSS_FACTOR &&
    peak - baseline > RSS_FLOOR_BYTES
  )
    violations.push(
      'rss grew ' +
        factor.toFixed(2) +
        'x after warm-up (' +
        Math.round(baseline / 1048576) +
        ' to ' +
        Math.round(peak / 1048576) +
        ' MB)',
    );
  return {
    seed: options.seed,
    requestedMinutes: options.minutes ?? null,
    durationMs: Date.now() - started,
    iterations,
    scenarioCounts,
    faultCounts,
    phaseCounts,
    memory: {
      firstRss: rss[0] ?? 0,
      lastRss: rss.at(-1) ?? 0,
      maxRss: rss.length ? Math.max(...rss) : 0,
      warmupIterations: warmup,
      baselineRss: baseline,
      maxFactorAfterWarmup: Number(factor.toFixed(3)),
      allowedFactor: RSS_FACTOR,
      floorBytes: RSS_FLOOR_BYTES,
    },
    maxTimerGapMs,
    violations,
  };
}
