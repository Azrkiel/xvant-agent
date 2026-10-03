import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { suitePath, verifyFrozen, type BenchmarkTask } from './suite.ts';

const count = z.number().int().nonnegative().nullable();
export const attemptRecordSchema = z.strictObject({
  suiteId: z.string(),
  frozenHash: z.string(),
  taskId: z.string(),
  configuration: z.string(),
  repeat: z.number().int().positive(),
  /**
   * `accepted`: the hidden check passed. `failed`: it did not, or the
   * configuration gave up. `incomplete`: a quota or availability limit
   * stopped the attempt; it is never counted as a success and never retried
   * automatically; so does an attempt the host was suspended under.
   * `excluded`: declared up front with a reason.
   */
  status: z.enum(['accepted', 'failed', 'incomplete', 'excluded']),
  reason: z.string().max(500).optional(),
  startedAt: z.string(),
  elapsedMs: z.number().int().nonnegative(),
  checkPassed: z.boolean().nullable(),
  /** Unknown stays null; nothing here is estimated. */
  /** Some runtimes report only a total; each figure is recorded as given. */
  usage: z.strictObject({
    inputTokens: count,
    outputTokens: count,
    totalTokens: count,
  }),
  toolFailures: count,
  conflicts: count,
  recovered: z.boolean().nullable(),
  humanRework: z.boolean().nullable(),
  versions: z.record(z.string(), z.string()),
});
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

/** What a configuration reports about its own attempt. It cannot set the status of a passing run. */
export interface AttemptResult {
  /** `gave_up` fails the attempt without running the check. */
  outcome: 'finished' | 'gave_up';
  reason?: string;
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  toolFailures?: number | null;
  conflicts?: number | null;
  recovered?: boolean | null;
}
/** Thrown by a configuration when a subscription or model limit stops it. */
export class QuotaInterrupted extends Error {}
export interface Configuration {
  /** Runtime, model and skill versions recorded with every attempt. */
  versions: Record<string, string>;
  run(input: {
    task: Pick<
      BenchmarkTask,
      'id' | 'objective' | 'timeoutMs' | 'acceptanceCriteria' | 'visibleTests'
    >;
    workspace: string;
    baseCommit: string;
    signal: AbortSignal;
  }): Promise<AttemptResult>;
}
export interface Scheduled {
  taskId: string;
  configuration: string;
  repeat: number;
}
export const attemptKey = (a: Scheduled) =>
  a.taskId + '\0' + a.configuration + '\0' + a.repeat;

export function readRecords(path: string): AttemptRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => attemptRecordSchema.parse(JSON.parse(line)));
}

function prepare(source: string, workspace: string): string {
  cpSync(source, workspace, { recursive: true });
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
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      { cwd: workspace, encoding: 'utf8', windowsHide: true },
    ).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'benchmark base');
  return git('rev-parse', 'HEAD');
}

/**
 * Runs every scheduled attempt that has no record yet, one at a time, and
 * appends a record for each before starting the next, so a stopped campaign
 * resumes where it left off. Each attempt gets a fresh copy of the frozen
 * repository; the acceptance check stays outside the workspace and is run
 * by the host afterwards.
 */
export async function runBenchmark(options: {
  suiteDir: string;
  configurations: Record<string, Configuration>;
  repeats: number;
  /** JSON lines, one record per attempt. */
  recordsPath: string;
  workRoot: string;
  exclusions?: (Scheduled & { reason: string })[];
  signal?: AbortSignal;
  /** Wall clock; tests replace it. */
  now?: () => number;
  onRecord?: (record: AttemptRecord) => void;
}): Promise<{ schedule: Scheduled[]; records: AttemptRecord[] }> {
  const { suite, lock } = verifyFrozen(options.suiteDir);
  const schedule: Scheduled[] = [];
  for (const task of suite.tasks)
    for (const configuration of Object.keys(options.configurations))
      for (let repeat = 1; repeat <= options.repeats; repeat += 1)
        schedule.push({ taskId: task.id, configuration, repeat });
  const existing = readRecords(options.recordsPath);
  if (existing.some((r) => r.frozenHash !== lock.frozenHash))
    throw new Error('RECORDS_FROM_ANOTHER_FREEZE');
  const done = new Set(existing.map(attemptKey));
  const excluded = new Map(
    (options.exclusions ?? []).map((e) => [attemptKey(e), e.reason]),
  );
  mkdirSync(options.workRoot, { recursive: true });
  for (const attempt of schedule) {
    if (done.has(attemptKey(attempt))) continue;
    if (options.signal?.aborted) break;
    const task = suite.tasks.find((t) => t.id === attempt.taskId)!;
    const configuration = options.configurations[attempt.configuration]!;
    const now = options.now ?? Date.now;
    const startedAt = new Date(now());
    const record: AttemptRecord = {
      suiteId: suite.id,
      frozenHash: lock.frozenHash,
      ...attempt,
      status: 'failed',
      startedAt: startedAt.toISOString(),
      elapsedMs: 0,
      checkPassed: null,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      toolFailures: null,
      conflicts: null,
      recovered: null,
      humanRework: null,
      versions: configuration.versions,
    };
    const reason = excluded.get(attemptKey(attempt));
    if (reason !== undefined) {
      record.status = 'excluded';
      record.reason = reason;
    } else {
      const workspace = join(
        options.workRoot,
        [
          attempt.taskId,
          attempt.configuration,
          attempt.repeat,
          Date.now(),
        ].join('-'),
      );
      const baseCommit = prepare(
        suitePath(options.suiteDir, task.repo),
        workspace,
      );
      const timeout = AbortSignal.timeout(task.timeoutMs);
      try {
        const result = await configuration.run({
          task: {
            id: task.id,
            objective: task.objective,
            timeoutMs: task.timeoutMs,
            ...(task.acceptanceCriteria
              ? { acceptanceCriteria: task.acceptanceCriteria }
              : {}),
            ...(task.visibleTests ? { visibleTests: task.visibleTests } : {}),
          },
          workspace,
          baseCommit,
          signal: options.signal
            ? AbortSignal.any([options.signal, timeout])
            : timeout,
        });
        record.usage = result.usage ?? record.usage;
        record.toolFailures = result.toolFailures ?? null;
        record.conflicts = result.conflicts ?? null;
        record.recovered = result.recovered ?? null;
        if (result.outcome === 'gave_up') {
          record.reason = (result.reason ?? 'gave up').slice(0, 500);
        } else {
          const check = spawnSync(
            process.execPath,
            [suitePath(options.suiteDir, task.check)],
            { cwd: workspace, timeout: 120_000, windowsHide: true },
          );
          record.checkPassed = check.status === 0;
          record.status = record.checkPassed ? 'accepted' : 'failed';
          if (!record.checkPassed) record.reason = 'acceptance check failed';
        }
      } catch (error) {
        if (error instanceof QuotaInterrupted) {
          record.status = 'incomplete';
          record.reason = ('quota: ' + error.message).slice(0, 500);
        } else {
          record.reason = (
            timeout.aborted
              ? 'timed out'
              : 'configuration error: ' + (error as Error).message
          ).slice(0, 500);
        }
      }
      record.elapsedMs = now() - startedAt.getTime();
      // An attempt cannot outlive its timeout unless the host was suspended
      // under it. Whatever it reported, its result and timing are not evidence.
      if (record.elapsedMs > task.timeoutMs * 2) {
        record.status = 'incomplete';
        record.checkPassed = null;
        record.reason = 'host suspended during the attempt';
      }
    }
    appendFileSync(options.recordsPath, JSON.stringify(record) + '\n');
    done.add(attemptKey(attempt));
    options.onRecord?.(record);
  }
  return { schedule, records: readRecords(options.recordsPath) };
}
