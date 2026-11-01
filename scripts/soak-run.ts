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
  type RootSpec,
  type RootState,
  type TurnOutcome,
  type TurnRequest,
  type TurnRunner,
  type WorkerSpec,
} from '../apps/controller/src/orchestrator.ts';

// Soak: the real orchestrator, store, worktrees, integration branch and host
// checks against throwaway Git repositories, with faults from a seeded
// generator. The offline driver (below) uses a fake turn runner and never
// calls a model; the live driver (soak-live.ts) runs real turns and takes its
// faults from the environment. Both run the same loop and the same invariants.

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
export const TERMINAL = new Set([
  'ready',
  'failed',
  'needs_attention',
  'cancelled',
]);
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
/** A weighted draw from a scenario table; the table's order and weights decide it. */
export function pickWeighted<T extends string>(
  random: () => number,
  weights: Record<T, number>,
): T {
  const names = Object.keys(weights) as T[];
  const total = Object.values<number>(weights).reduce((a, b) => a + b, 0);
  let n = random() * total;
  for (const name of names) {
    n -= weights[name];
    if (n < 0) return name;
  }
  return names[0]!;
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

export interface Call {
  label: string;
  attempt: number;
  status: TurnOutcome['status'];
}
/** The turn label inside a task id: `<root id>-<label>-<n>`. */
const labelOf = (prefix: string, taskId: string) =>
  taskId.slice(prefix.length + 1, taskId.lastIndexOf('-'));
/** Wraps a turn runner and records the status of every turn, as the fake does. */
export class RecordingRunner implements TurnRunner {
  readonly calls: Call[] = [];
  readonly #inner: TurnRunner;
  readonly #prefix: string;
  readonly #count = new Map<string, number>();
  constructor(inner: TurnRunner, prefix: string) {
    this.#inner = inner;
    this.#prefix = prefix;
  }
  interrupt(taskId: string) {
    return this.#inner.interrupt(taskId);
  }
  async run(request: TurnRequest): Promise<TurnOutcome> {
    const label = labelOf(this.#prefix, request.taskId);
    const attempt = (this.#count.get(label) ?? 0) + 1;
    this.#count.set(label, attempt);
    try {
      const outcome = await this.#inner.run(request);
      this.calls.push({ label, attempt, status: outcome.status });
      return outcome;
    } catch (error) {
      // The orchestrator reads a thrown turn as an unknown outcome.
      this.calls.push({ label, attempt, status: 'unknown' });
      throw error;
    }
  }
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
    const label = labelOf(this.prefix, request.taskId);
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

export const gitIn = (cwd: string, ...args: string[]) =>
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

type GraphEvent = { kind: string; payload: unknown };
/** What a driver reports about one finished iteration, beyond the shared invariants. */
export interface Findings {
  problems: string[];
  /** Observations that are not violations: what the model or the environment did. */
  notes: string[];
  /** The run-wide fault counters; a driver may add its own keys. */
  faults: Record<string, number>;
}
export interface IterationContext {
  n: number;
  id: string;
  /** The iteration's own directory; it is removed afterwards. */
  dir: string;
  store: Store;
  objects: ArtifactStore;
  random: () => number;
}
export interface IterationPlan {
  workers: WorkerSpec[];
  runner: TurnRunner;
  /** Turns, in order, with their statuses; the shared invariants read it. */
  calls: () => Call[];
  /** Files committed in the base revision, besides the README. */
  files?: Record<string, string>;
  spec: Pick<RootSpec, 'objective' | 'acceptanceCriteria' | 'checks'> &
    Partial<RootSpec>;
  /** The terminal phases this scenario may legally end in. */
  expected: () => readonly string[];
  onChange?: (
    state: RootState,
    kind: string,
    control: { cancel: () => void },
  ) => void;
  /** Scenario-specific invariants, observations and fault counts. */
  inspect: (
    state: RootState,
    events: GraphEvent[],
    calls: Call[],
    out: Findings,
  ) => void;
  /** Called when the iteration is over, however it ended. */
  dispose?: () => void;
}
export interface SoakDriver {
  mode: 'offline' | 'live';
  scenarios: readonly string[];
  pick: (random: () => number) => string;
  iterationTimeoutMs: number;
  /** A reason to stop before the next iteration (quota or login trouble), if there is one. */
  halt?: () => string | undefined;
  plan: (scenario: string, context: IterationContext) => IterationPlan;
  /** Starts watching an iteration; `finish` returns the violations it found. */
  watch?: () => Promise<{ finish: () => Promise<string[]> }>;
}

const startsRepair = (e: GraphEvent) =>
  e.kind === 'node.repair' &&
  String((e.payload as { reason?: string }).reason).startsWith(
    'Integration conflict',
  );
const failedCheck = (e: GraphEvent) =>
  e.kind === 'graph.checked' &&
  !!(e.payload as { checks?: { status: string }[] }).checks?.some(
    (c) => c.status === 'failed',
  );
const rejectedReview = (e: GraphEvent) =>
  e.kind === 'graph.reviewed' &&
  (e.payload as { approve?: boolean }).approve === false;

const offlineDriver: SoakDriver = {
  mode: 'offline',
  scenarios: SCENARIOS,
  pick: (random) => pickWeighted(random, WEIGHTS),
  iterationTimeoutMs: ITERATION_TIMEOUT_MS,
  plan(name, context) {
    const scenario = name as Scenario;
    const runner = new SoakRunner(
      scenario,
      context.id,
      context.objects,
      context.random,
    );
    return {
      workers,
      runner,
      calls: () => runner.calls,
      spec: {
        objective: 'soak ' + scenario,
        acceptanceCriteria: ['a, b and c exist'],
        checks: check,
        plan: buildPlan(scenario),
      },
      expected: () => [EXPECTED_PHASE[scenario]],
      inspect(state, events, calls, out) {
        const { problems } = out;
        if (
          scenario === 'review_reject_standing' &&
          (state.review?.approve ?? true)
        )
          problems.push('a standing rejection was recorded as approved');
        if (scenario === 'review_reject_fixed' && !state.review?.approve)
          problems.push('the repaired result was not approved');
        if (
          calls.every((c) => c.status !== 'unknown') &&
          scenario.includes('unknown')
        )
          problems.push('the unknown outcome was never injected');
        // A scenario that ends ready proves nothing unless its fault happened.
        if (scenario.startsWith('check_failure') && !events.some(failedCheck))
          problems.push('the failing check was never seen');
        if (
          scenario.startsWith('turn_failure') &&
          !calls.some((c) => c.status === 'failed')
        )
          problems.push('the turn failure was never injected');
        if (scenario.startsWith('review_') && !events.some(rejectedReview))
          problems.push('the rejecting review was never seen');
        if (
          scenario.startsWith('review_') &&
          !events.some((e) => e.kind === 'graph.review_fix')
        )
          problems.push('the review repair never ran');
        if (scenario === 'conflicting_patches' && !events.some(startsRepair))
          problems.push('no integration conflict was observed');
      },
    };
  },
};

export interface SoakOutcome {
  iteration: number;
  scenario: string;
  phase: string | null;
  reason: string | null;
  durationMs: number;
  notes: string[];
  violations: string[];
}
export interface SoakReport {
  seed: number;
  requestedMinutes: number | null;
  durationMs: number;
  iterations: number;
  scenarioCounts: Record<string, number>;
  /** Faults seen by the orchestrator, counted from its own events. */
  faultCounts: Record<string, number>;
  phaseCounts: Record<string, number>;
  /** One entry per iteration; only a live run keeps them. */
  outcomes?: SoakOutcome[];
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
  driver?: SoakDriver;
  log?: (line: string) => void;
}): Promise<SoakReport> {
  const log = options.log ?? (() => {});
  const driver = options.driver ?? offlineDriver;
  const random = seeded(options.seed);
  const started = Date.now();
  const deadline = started + (options.minutes ?? 0) * 60000;
  const master = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-soak-')));
  // A temp directory of its own, so leftovers are this run's and nobody else's:
  // other XVANT processes on the host write patch files to the shared one.
  const sharedTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  const ownTemp = join(master, 'tmp');
  mkdirSync(ownTemp);
  process.env.TEMP = process.env.TMP = ownTemp;
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
  const outcomes: SoakOutcome[] = [];
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
      const halted = driver.halt?.();
      if (halted) {
        violations.push(
          'soak stopped before iteration ' + iterations + ': ' + halted,
        );
        break;
      }
      const n = iterations++;
      const iterationStart = Date.now();
      const scenario = driver.pick(random);
      scenarioCounts[scenario] = (scenarioCounts[scenario] ?? 0) + 1;
      const where = 'iteration ' + n + ' (' + scenario + '): ';
      const findings: Findings = {
        problems: [],
        notes: [],
        faults: faultCounts,
      };
      const problems = findings.problems;
      const dir = join(master, 'i' + n);
      const repo = join(dir, 'repo');
      const runs = join(dir, 'runs');
      mkdirSync(repo, { recursive: true });
      const id = 'soak-' + n;
      const iteration = driver.plan(scenario, {
        n,
        id,
        dir,
        store,
        objects,
        random,
      });
      gitIn(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'base\n');
      for (const [file, text] of Object.entries(iteration.files ?? {}))
        writeFileSync(join(repo, file), text);
      gitIn(repo, 'add', '.');
      gitIn(repo, 'commit', '-qm', 'base');
      const before = checkout(repo);
      const orchestrator: Orchestrator = new Orchestrator(
        store,
        iteration.runner,
        iteration.workers,
        {
          stateRoot: runs,
          onChange: (state, kind) =>
            iteration.onChange?.(state, kind, {
              cancel: () => orchestrator.cancel(),
            }),
        },
      );
      const watcher = await driver.watch?.();
      let state: RootState | undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        state = await Promise.race([
          orchestrator.run({
            id,
            projectId: 'soak',
            repository: repo,
            baseRevision: 'main',
            ...iteration.spec,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('iteration timed out')),
              driver.iterationTimeoutMs,
            );
          }),
        ]);
      } catch (error) {
        problems.push('run threw: ' + (error as Error).message);
        // A run that timed out is still going; stop it before its directory goes.
        orchestrator.cancel();
      } finally {
        clearTimeout(timer);
        iteration.dispose?.();
      }
      if (state) {
        phaseCounts[state.phase] = (phaseCounts[state.phase] ?? 0) + 1;
        const events = store.graphs.events(id);
        const calls = iteration.calls();
        // 1. A terminal phase, and the one the injected fault calls for.
        const expected = iteration.expected();
        if (!TERMINAL.has(state.phase))
          problems.push('ended in non-terminal phase ' + state.phase);
        else if (!expected.includes(state.phase))
          problems.push(
            'phase ' +
              state.phase +
              ', expected ' +
              expected.join(' or ') +
              (state.reason ? ' (' + state.reason + ')' : ''),
          );
        // 2. An unknown outcome is never retried or re-dispatched.
        const unknown = calls.filter((c) => c.status === 'unknown');
        for (const u of unknown) {
          const later = calls.filter(
            (c) => c.label === u.label && c.attempt > u.attempt,
          );
          if (later.length)
            problems.push('unknown outcome of ' + u.label + ' was retried');
          if (u.label === 'fix' || u.label === 'review-fix') {
            const index = calls.indexOf(u);
            if (index !== calls.length - 1)
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
        // Faults as the orchestrator saw them.
        for (const call of calls) {
          if (call.status === 'failed') faultCounts.turn_failure!++;
          if (call.status === 'unknown') faultCounts.unknown_outcome!++;
        }
        for (const e of events) {
          if (startsRepair(e)) faultCounts.integration_conflict!++;
          if (failedCheck(e)) faultCounts.check_failure!++;
          if (rejectedReview(e)) faultCounts.review_rejection!++;
        }
        iteration.inspect(state, events, calls, findings);
      }
      if (watcher) problems.push(...(await watcher.finish()));
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
      outcomes.push({
        iteration: n,
        scenario,
        phase: state?.phase ?? null,
        reason: state?.reason ?? null,
        durationMs: Date.now() - iterationStart,
        notes: findings.notes,
        violations: problems,
      });
      log(
        where +
          (state?.phase ?? 'no result') +
          (findings.notes.length
            ? ' [' + findings.notes.join('; ') + ']'
            : '') +
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
    for (const [key, value] of Object.entries(sharedTemp))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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
    ...(driver.mode === 'live' ? { outcomes } : {}),
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
