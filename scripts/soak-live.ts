import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RosterRuntime } from '../apps/controller/src/live-roster.ts';
import type { LiveEvent } from '../apps/controller/src/codex-live.ts';
import type { Check, WorkerSpec } from '../apps/controller/src/orchestrator.ts';
import { LiveTurnRunner } from '../apps/controller/src/turn-runner.ts';
import { discoverRuntime } from '../packages/adapters/src/live/discover.ts';
import {
  RecordingRunner,
  TERMINAL,
  type Findings,
  type IterationContext,
  type IterationPlan,
  type SoakDriver,
  type SoakOutcome,
  type SoakReport,
} from './soak-run.ts';

// Live soak: the loop and the invariants of the offline soak, with real Claude
// Code turns on Haiku through LiveTurnRunner. A live turn cannot be scripted to
// fail, so the faults come from the environment: a check the criteria do not
// mention, a check that cannot pass, a cancel while a turn runs, and two
// parallel nodes that edit the same line.

export const LIVE_MODEL = 'haiku';
export const LIVE_SCENARIOS = [
  'clean',
  'check_fails_first',
  'impossible_check',
  'cancel_mid_run',
  'conflicting_nodes',
] as const;
export type LiveScenario = (typeof LIVE_SCENARIOS)[number];
/** The cancel arrives this long after the first node is dispatched. */
export const CANCEL_AFTER_MS = 5000;
const ITERATION_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Scenario selection: a seeded shuffle of every scenario, repeated. A short run
 * therefore meets each fault before any repeats, and the same seed gives the
 * same order.
 */
export function scenarioPicker(
  random: () => number,
  scenarios: readonly string[] = LIVE_SCENARIOS,
): () => string {
  let bag: string[] = [];
  return () => {
    if (!bag.length) {
      bag = [...scenarios];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j]!, bag[i]!];
      }
    }
    return bag.shift()!;
  };
}

// The throwaway repository: plain JavaScript, no dependencies.
const BASE_FILES: Record<string, string> = {
  'greet.js':
    "module.exports = function greet(name) {\n  return 'Hello, ' + name;\n};\n",
  'math.js':
    'exports.sum = (list) => list.reduce((a, b) => a + b, 0);\nexports.max = (list) => Math.max(...list);\n',
  'index.js':
    "const greet = require('./greet.js');\nconst { sum } = require('./math.js');\nconsole.log(greet('world'), sum([1, 2, 3]));\n",
};
const REGISTRY = "module.exports = { last: 'none' };\n";

export interface LiveScenarioSpec {
  /** Committed in the base revision. */
  files: Record<string, string>;
  /** Check scripts, kept outside the repository so a worker does not read them. */
  checkFiles: Record<string, string>;
  /** The registered check, as a shell command line. */
  command: string;
  objective: string;
  acceptanceCriteria: string[];
  plan: {
    summary: string;
    nodes: {
      id: string;
      title: string;
      objective: string;
      acceptanceCriteria: string[];
      dependsOn: string[];
      writablePaths: string[];
    }[];
  };
  maxRepairs: number;
  maxActive: number;
  /** The terminal phases the scenario may end in when its fault happens. */
  phases: readonly string[];
}

const quote = (path: string) => '"' + path + '"';
const node = (
  id: string,
  title: string,
  objective: string,
  criteria: string[],
  writablePaths: string[],
) => ({
  id,
  title,
  objective,
  acceptanceCriteria: criteria,
  dependsOn: [],
  writablePaths,
});
const runCheck = (nodeExecutable: string, script: string) =>
  quote(nodeExecutable) + ' ' + quote(script);

/**
 * The repository, check and plan of a scenario. Pure: the check scripts are
 * returned, not written. The registered command runs the given Node binary,
 * so the check does not depend on PATH.
 */
export function buildLiveScenario(
  scenario: LiveScenario,
  checkDir: string,
  nodeExecutable: string = process.execPath,
): LiveScenarioSpec {
  const script = (name: string) => join(checkDir, name);
  const files = { ...BASE_FILES };
  if (scenario === 'clean') {
    const objective =
      "Add a file shout.js in the repository root that exports a function shout(text) with module.exports = shout. It returns the text in upper case followed by '!'. Do not change other files.";
    const criteria = [
      'shout.js exports the function directly (module.exports = shout)',
      "shout('hi') returns 'HI!'",
    ];
    return {
      files,
      checkFiles: {
        'check-shout.js':
          "const assert = require('node:assert');\nconst { join } = require('node:path');\nconst shout = require(join(process.cwd(), 'shout.js'));\nassert.strictEqual(typeof shout, 'function', 'shout.js must export a function');\nassert.strictEqual(shout('hi'), 'HI!');\n",
      },
      command: runCheck(nodeExecutable, script('check-shout.js')),
      objective,
      acceptanceCriteria: criteria,
      plan: {
        summary: 'soak clean',
        nodes: [
          node('shout', 'Add shout.js', objective, criteria, ['shout.js']),
        ],
      },
      maxRepairs: 2,
      maxActive: 1,
      phases: ['ready'],
    };
  }
  if (scenario === 'check_fails_first') {
    const objective =
      'Add a file add.js in the repository root that exports a function add(a, b) with module.exports = add. It returns a + b. Do not change other files.';
    const criteria = [
      'add.js exports the function directly (module.exports = add)',
      'add(2, 3) returns 5',
    ];
    return {
      files,
      // The check also demands a file that neither the objective nor the criteria mention.
      checkFiles: {
        'check-add.js':
          "const assert = require('node:assert');\nconst fs = require('node:fs');\nconst { join } = require('node:path');\nconst add = require(join(process.cwd(), 'add.js'));\nassert.strictEqual(add(2, 3), 5);\nlet version = null;\ntry {\n  version = fs.readFileSync(join(process.cwd(), 'VERSION.txt'), 'utf8');\n} catch {}\nif (version !== '1.0.0\\n') {\n  console.error('CHECK FAILED: the repository root must contain a file VERSION.txt whose content is exactly 1.0.0 followed by a newline.');\n  process.exit(1);\n}\n",
      },
      command: runCheck(nodeExecutable, script('check-add.js')),
      objective,
      acceptanceCriteria: criteria,
      plan: {
        summary: 'soak check_fails_first',
        nodes: [node('add', 'Add add.js', objective, criteria, ['add.js'])],
      },
      maxRepairs: 1,
      maxActive: 1,
      phases: ['ready', 'failed'],
    };
  }
  if (scenario === 'impossible_check') {
    const objective =
      'Add a file double.js in the repository root that exports a function double(n) with module.exports = double. It returns n * 2. Do not change other files.';
    const criteria = [
      'double.js exports the function directly (module.exports = double)',
      'double(4) returns 8',
    ];
    return {
      files,
      checkFiles: {},
      // Exits 1 whatever the repository holds.
      command: quote(nodeExecutable) + ' -e "process.exit(1)"',
      objective,
      acceptanceCriteria: criteria,
      plan: {
        summary: 'soak impossible_check',
        nodes: [
          node('double', 'Add double.js', objective, criteria, ['double.js']),
        ],
      },
      maxRepairs: 1,
      maxActive: 1,
      phases: ['failed'],
    };
  }
  if (scenario === 'cancel_mid_run') {
    const objective =
      'Add a file stats.js in the repository root that exports mean(list), median(list) and mode(list) (exports.mean = ..., and so on), each with a short comment. Do not change other files.';
    const criteria = [
      'stats.js exports mean, median and mode',
      'mean([1, 2, 3]) returns 2',
    ];
    return {
      files,
      checkFiles: {
        'check-stats.js':
          "const assert = require('node:assert');\nconst { join } = require('node:path');\nconst stats = require(join(process.cwd(), 'stats.js'));\nassert.strictEqual(stats.mean([1, 2, 3]), 2);\nassert.strictEqual(typeof stats.median, 'function');\nassert.strictEqual(typeof stats.mode, 'function');\n",
      },
      command: runCheck(nodeExecutable, script('check-stats.js')),
      objective,
      acceptanceCriteria: criteria,
      plan: {
        summary: 'soak cancel_mid_run',
        nodes: [
          node('stats', 'Add stats.js', objective, criteria, ['stats.js']),
        ],
      },
      maxRepairs: 1,
      maxActive: 1,
      phases: ['cancelled'],
    };
  }
  // conflicting_nodes: two parallel nodes with disjoint writable paths, which
  // the plan validator accepts, whose objectives both rewrite the same line of
  // registry.js. Whichever integrates second collides with the first.
  const line = (who: string, file: string) =>
    node(
      who,
      'Add ' + file + ' and register it',
      'Create ' +
        file +
        " with a single line module.exports = '" +
        who +
        "';. Then register it: in registry.js, change the value on the line starting with module.exports to { last: '" +
        who +
        "' }. registry.js is shared with another task; you must change that one line anyway.",
      [file + " exports '" + who + "'", "registry.js has last: '" + who + "'"],
      [file],
    );
  const objective =
    'Add feature-a.js and feature-b.js, and record the feature added last in registry.js.';
  return {
    files: { ...files, 'registry.js': REGISTRY },
    checkFiles: {
      'check-registry.js':
        "const assert = require('node:assert');\nconst { join } = require('node:path');\nconst cwd = process.cwd();\nassert.strictEqual(require(join(cwd, 'feature-a.js')), 'a');\nassert.strictEqual(require(join(cwd, 'feature-b.js')), 'b');\nconst last = require(join(cwd, 'registry.js')).last;\nassert.ok(last === 'a' || last === 'b', 'registry.js last must be a or b');\n",
    },
    command: runCheck(nodeExecutable, script('check-registry.js')),
    objective,
    acceptanceCriteria: [
      'feature-a.js exports a',
      'feature-b.js exports b',
      'registry.js records one of them as last',
    ],
    plan: {
      summary: 'soak conflicting_nodes',
      nodes: [line('a', 'feature-a.js'), line('b', 'feature-b.js')],
    },
    maxRepairs: 1,
    maxActive: 2,
    phases: ['ready', 'failed', 'needs_attention'],
  };
}

// --- Process tracking -------------------------------------------------------
// A live iteration is only clean if no process it started is still running.
// Method: a snapshot of the whole process table from PowerShell
// `Get-CimInstance Win32_Process` (wmic is deprecated and missing from recent
// Windows 11 builds), taken before the iteration, every few seconds during it,
// and after it. Windows does not re-parent an orphan, so its ParentProcessId
// keeps naming the dead parent; the poll during the iteration is what lets an
// orphan be recognised later. A process counts as the iteration's when its
// parent chain leads to this process or to a process seen that way. The
// sampler's own subtree is excluded.

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Creation time, a number that grows with time (Windows file time). */
  created: number;
  name: string;
}
export const processKey = (row: ProcessRow) => row.pid + ':' + row.created;

/** Parses `pid ppid created name` lines. */
export function parseProcessList(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+) (\d+) (\d+) (.+?)\s*$/.exec(line);
    if (m)
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        created: Number(m[3]),
        name: m[4]!,
      });
  }
  return rows;
}
/**
 * Rows whose parent chain leads to `root` or to a pid in `extraRoots`. A child
 * older than its parent is a reused pid and does not count.
 */
export function descendantsOf(
  rows: readonly ProcessRow[],
  root: number,
  extraRoots: ReadonlySet<number> = new Set(),
): ProcessRow[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const found = new Map<number, ProcessRow>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (found.has(row.pid) || row.pid === root) continue;
      const parent = byPid.get(row.ppid);
      const linked =
        found.has(row.ppid) || row.ppid === root || extraRoots.has(row.ppid);
      if (linked && (!parent || parent.created <= row.created)) {
        found.set(row.pid, row);
        grew = true;
      }
    }
  }
  return [...found.values()];
}
/** Processes of this iteration still alive now. */
export function leakedProcesses(
  seen: ReadonlyMap<string, ProcessRow>,
  rows: readonly ProcessRow[],
  root: number,
  sampler: number | null,
  ignore: ReadonlySet<string>,
): ProcessRow[] {
  const sampled = new Set(
    sampler === null
      ? []
      : [sampler, ...descendantsOf(rows, sampler).map((r) => r.pid)],
  );
  const seenPids = new Set([...seen.values()].map((r) => r.pid));
  const mine = new Set(
    descendantsOf(rows, root, seenPids).map((r) => processKey(r)),
  );
  return rows.filter((r) => {
    const key = processKey(r);
    return (
      !ignore.has(key) &&
      !sampled.has(r.pid) &&
      (mine.has(key) || seen.has(key))
    );
  });
}

const LIST_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }), $_.Name }";
interface Snapshot {
  rows: ProcessRow[];
  sampler: number | null;
}
function snapshotProcesses(): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const [command, args] =
      process.platform === 'win32'
        ? ([
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', LIST_SCRIPT],
          ] as const)
        : (['ps', ['-eo', 'pid=,ppid=,comm=']] as const);
    const child = execFile(
      command,
      [...args],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
      (error, stdout) => {
        if (error) return reject(error);
        const text =
          process.platform === 'win32'
            ? stdout
            : stdout.replace(/^\s*(\d+)\s+(\d+)\s+/gm, '$1 $2 0 ');
        resolve({ rows: parseProcessList(text), sampler: child.pid ?? null });
      },
    );
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts watching the processes this one spawns; `finish` reports what outlived the iteration. */
export async function watchChildProcesses(
  options: { root?: number; pollMs?: number; graceMs?: number } = {},
) {
  const root = options.root ?? process.pid;
  const first = await snapshotProcesses();
  const ignore = new Set(
    descendantsOf(first.rows, root)
      .filter((r) => r.pid !== first.sampler)
      .map(processKey),
  );
  const seen = new Map<string, ProcessRow>();
  const record = (snap: Snapshot) => {
    const sampled = new Set(
      snap.sampler === null
        ? []
        : [
            snap.sampler,
            ...descendantsOf(snap.rows, snap.sampler).map((r) => r.pid),
          ],
    );
    const seenPids = new Set([...seen.values()].map((r) => r.pid));
    for (const row of descendantsOf(snap.rows, root, seenPids))
      if (!sampled.has(row.pid) && !ignore.has(processKey(row)))
        seen.set(processKey(row), row);
  };
  let polling: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    // One poll at a time; a slow sampler skips ticks.
    polling = polling.then(async () => {
      try {
        record(await snapshotProcesses());
      } catch {
        /* the final snapshot decides */
      }
    });
  }, options.pollMs ?? 5000);
  return {
    async finish(): Promise<string[]> {
      clearInterval(timer);
      await polling;
      const deadline = Date.now() + (options.graceMs ?? 10000);
      let leaked: ProcessRow[] = [];
      for (;;) {
        const snap = await snapshotProcesses();
        record(snap);
        leaked = leakedProcesses(seen, snap.rows, root, snap.sampler, ignore);
        if (!leaked.length || Date.now() > deadline) break;
        await sleep(1000);
      }
      // Reported, then stopped, so one leak does not hide in the next iteration.
      for (const row of leaked) {
        ignore.add(processKey(row));
        try {
          process.kill(row.pid);
        } catch {
          /* already gone */
        }
      }
      return leaked.map(
        (r) =>
          'process still running after the iteration: ' +
          r.name +
          ' pid ' +
          r.pid,
      );
    },
  };
}

// --- The driver -------------------------------------------------------------
const TROUBLE =
  /usage limit|rate limit|quota|not logged in|\/login|unauthori[sz]ed|authentication/i;

export interface LiveDriver extends SoakDriver {
  runtime: { executable: string; version: string | null };
  model: string;
}
/** Refuses unless Claude is qualified and processes can be tracked. */
export async function createLiveDriver(): Promise<LiveDriver> {
  const found = discoverRuntime('claude');
  if (found.status !== 'qualified' || !found.executable)
    throw new Error(
      'Claude is not qualified (' +
        found.status +
        (found.version ? ' ' + found.version : '') +
        '); run: npm run xvant -- runtimes',
    );
  const runtimes: { claude: RosterRuntime } = {
    claude: {
      executable: found.executable,
      ...(found.version ? { version: found.version } : {}),
    },
  };
  const { defaultWorkers, shellCheck } =
    await import('../apps/controller/src/app.ts');
  const { applyRouting } =
    await import('../apps/controller/src/routing-default.ts');
  const workers: WorkerSpec[] = defaultWorkers(['claude']);
  applyRouting(workers, runtimes, { models: { claude: LIVE_MODEL } });
  if (runtimes.claude.model !== LIVE_MODEL)
    throw new Error('The runtime model could not be set to ' + LIVE_MODEL);
  // Fail now, not mid-run, if the process table cannot be read.
  const probe = await snapshotProcesses();
  if (!probe.rows.some((r) => r.pid === process.pid))
    throw new Error('Cannot read the process table');
  let halt: string | undefined;
  let pick: (() => string) | undefined;
  return {
    mode: 'live',
    scenarios: LIVE_SCENARIOS,
    iterationTimeoutMs: ITERATION_TIMEOUT_MS,
    runtime: { executable: found.executable, version: found.version },
    model: LIVE_MODEL,
    pick(random) {
      pick ??= scenarioPicker(random);
      return pick();
    },
    halt: () => halt,
    watch: () => watchChildProcesses(),
    plan(name, context: IterationContext): IterationPlan {
      const scenario = name as LiveScenario;
      const checkDir = join(context.dir, 'checks');
      mkdirSync(checkDir, { recursive: true });
      const spec = buildLiveScenario(scenario, checkDir);
      for (const [file, text] of Object.entries(spec.checkFiles))
        writeFileSync(join(checkDir, file), text);
      const trouble: string[] = [];
      const runner = new RecordingRunner(
        new LiveTurnRunner(context.store, context.objects, workers, runtimes, {
          onEvent: (alias, _task, event: LiveEvent) => {
            if (event.kind === 'auth' || TROUBLE.test(event.text)) {
              const text = alias + ': ' + event.text.slice(0, 160);
              if (!trouble.includes(text)) trouble.push(text);
              if (TROUBLE.test(event.text)) halt = text;
            }
          },
        }),
        context.id,
      );
      let timer: NodeJS.Timeout | undefined;
      let cancelAt: number | undefined;
      let cancelDelivered = false;
      return {
        workers,
        runner,
        calls: () => runner.calls,
        files: spec.files,
        spec: {
          objective: spec.objective,
          acceptanceCriteria: spec.acceptanceCriteria,
          checks: { check: shellCheck(spec.command) as Check },
          plan: spec.plan,
          maxRepairs: spec.maxRepairs,
          maxActive: spec.maxActive,
        },
        expected: () =>
          scenario === 'cancel_mid_run' && !cancelDelivered
            ? [...TERMINAL]
            : spec.phases,
        onChange(_state, kind, control) {
          if (
            scenario === 'cancel_mid_run' &&
            kind === 'node.dispatched' &&
            !timer
          ) {
            cancelAt = Date.now();
            timer = setTimeout(() => {
              cancelDelivered = true;
              control.cancel();
            }, CANCEL_AFTER_MS);
          }
        },
        dispose: () => clearTimeout(timer),
        inspect(state, events, calls, out: Findings) {
          liveInspect(scenario, state, events, calls, out, {
            cancelDelivered,
            cancelAt,
          });
          for (const text of trouble.slice(0, 3))
            out.notes.push('runtime: ' + text);
        },
      };
    },
  };
}

type Events = { kind: string; payload: unknown }[];
const reasonOf = (e: { payload: unknown }) =>
  String((e.payload as { reason?: string }).reason);
/** The scenario's own expectations. Observations go to `notes`; a broken invariant to `problems`. */
export function liveInspect(
  scenario: LiveScenario,
  state: { phase: string; checks: { id: string; status: string }[] },
  events: Events,
  calls: { status: string }[],
  out: Findings,
  cancel: { cancelDelivered: boolean; cancelAt: number | undefined },
) {
  const checkedFailed = events.some(
    (e) =>
      e.kind === 'graph.checked' &&
      (e.payload as { checks?: { status: string }[] }).checks?.some(
        (c) => c.status === 'failed',
      ),
  );
  const fixed = events.some((e) => e.kind === 'graph.fix');
  const allPassed =
    state.checks.length > 0 && state.checks.every((c) => c.status === 'passed');
  if (calls.some((c) => c.status === 'unknown'))
    out.notes.push('a turn had an unknown outcome');
  if (scenario === 'clean') {
    if (state.phase === 'ready' && !allPassed)
      out.problems.push('ready without a passing check');
    if (checkedFailed) out.notes.push('the check failed on a clean objective');
  } else if (scenario === 'check_fails_first') {
    if (!checkedFailed)
      out.notes.push('check passed first time (the fault was not exercised)');
    else if (state.phase === 'ready' && fixed)
      out.notes.push('repaired by a fix turn');
    else if (state.phase === 'failed') out.notes.push('repair budget ran out');
    if (state.phase === 'ready' && !allPassed)
      out.problems.push('ready without a passing check');
  } else if (scenario === 'impossible_check') {
    if (state.phase === 'ready')
      out.problems.push('an impossible check was ready');
    out.notes.push(
      checkedFailed ? 'check failed as designed' : 'the check never ran',
    );
  } else if (scenario === 'cancel_mid_run') {
    if (cancel.cancelDelivered) {
      out.faults.cancel_delivered = (out.faults.cancel_delivered ?? 0) + 1;
      out.notes.push('cancel delivered');
    } else out.notes.push('the run ended before the cancel was delivered');
  } else {
    const conflict = events.some(
      (e) =>
        e.kind === 'node.repair' &&
        reasonOf(e).startsWith('Integration conflict'),
    );
    out.notes.push(
      conflict
        ? 'integration conflict observed'
        : 'no integration conflict (the model avoided it)',
    );
  }
}

// --- The receipt ------------------------------------------------------------
export const LIVE_LIMITATIONS = [
  'Haiku only: every role runs on the haiku model of one Claude Code version through a subscription login. Other models, Codex and OpenCode are not exercised.',
  'Tiny objectives: one or two small plain-JavaScript files per iteration, with a plan supplied up front, so planning turns and larger changes are not exercised.',
  'Minutes, not hours: the run is bounded by --minutes and --max-iterations; leaks and drift that need hours or hundreds of turns would not show.',
  'One host and one process: this machine at the time of the run; no concurrent roots, no crash and resume, no other platform.',
  'Faults come from the environment and the model, not from a script: a scenario can end without its fault having happened (the receipt records which), and a model may avoid a conflict or guess a hidden requirement.',
  'Memory is process rss of the soak itself, sampled once per iteration; Claude child processes are not included. Child processes are tracked by sampling the process table (PowerShell Get-CimInstance Win32_Process) every few seconds and after each iteration; a process that starts and exits between samples is not seen, and one that exits is not a leak.',
  'The Claude subscription and the host were shared with other work during the run.',
];

/** Per scenario: runs, the phases reached, and what was observed. */
export function summarizeOutcomes(outcomes: readonly SoakOutcome[]) {
  const summary: Record<
    string,
    {
      runs: number;
      phases: Record<string, number>;
      observed: Record<string, number>;
      violations: number;
    }
  > = {};
  for (const o of outcomes) {
    const s = (summary[o.scenario] ??= {
      runs: 0,
      phases: {},
      observed: {},
      violations: 0,
    });
    s.runs++;
    const phase = o.phase ?? 'no result';
    s.phases[phase] = (s.phases[phase] ?? 0) + 1;
    for (const note of o.notes) s.observed[note] = (s.observed[note] ?? 0) + 1;
    s.violations += o.violations.length;
  }
  return summary;
}

/** The receipt fields a live soak adds to the shared report. */
export function liveReceipt(
  run: SoakReport,
  meta: {
    minutes: number;
    maxIterations: number | null;
    model: string;
    runtime: { executable: string; version: string | null };
  },
) {
  const problems = [...run.violations];
  if (run.iterations === 0) problems.push('No iteration ran');
  const scenarios = summarizeOutcomes(run.outcomes ?? []);
  return {
    classification: 'live' as const,
    minutes: meta.minutes,
    maxIterations: meta.maxIterations,
    model: meta.model,
    runtime: { kind: 'claude', ...meta.runtime },
    scenarios,
    problems,
  };
}
