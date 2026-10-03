import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const CATEGORIES = [
  'debugging',
  'feature',
  'cross-module',
  'test-review',
] as const;
export const taskSchema = z.strictObject({
  id,
  category: z.enum(CATEGORIES),
  /** Tuning tasks may inform candidates; held-out tasks decide promotion. */
  split: z.enum(['tuning', 'held-out']),
  /** Whether one worker should suffice or parallel work is expected to help. */
  shape: z.enum(['single', 'parallel']),
  objective: z.string().min(1).max(2000),
  /** Starting repository, relative to the suite directory. */
  repo: z.string().min(1).max(256),
  /** Acceptance check, relative to the suite directory. It is never copied into the workspace. */
  check: z.string().min(1).max(256),
  timeoutMs: z.number().int().positive().max(3_600_000),
});
export const suiteSchema = z.strictObject({
  id,
  version: z.number().int().positive(),
  tasks: z.array(taskSchema).min(1).max(200),
});
export type BenchmarkTask = z.infer<typeof taskSchema>;
export type Suite = z.infer<typeof suiteSchema>;

export const lockSchema = z.strictObject({
  suiteId: id,
  version: z.number().int().positive(),
  tasks: z.record(
    id,
    z.strictObject({
      taskHash: z.string().regex(/^[0-9a-f]{64}$/),
      repoHash: z.string().regex(/^[0-9a-f]{64}$/),
      checkHash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
  frozenHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SuiteLock = z.infer<typeof lockSchema>;

const sha = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

/** Resolves a suite-relative path. It may reach sibling fixture directories but not leave the fixtures root two levels up. */
export function suitePath(suiteDir: string, relative: string): string {
  const path = resolve(suiteDir, relative);
  const base = resolve(suiteDir, '..', '..');
  if (!path.startsWith(base + sep)) throw new Error('SUITE_PATH_ESCAPE');
  return path;
}

function treeHash(root: string): string {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, prefix + name + '/');
      else files.push(prefix + name + '\0' + sha(readFileSync(path)));
    }
  };
  walk(root, '');
  return sha(files.join('\n'));
}

export function loadSuite(suiteDir: string): Suite {
  const suite = suiteSchema.parse(
    JSON.parse(readFileSync(join(suiteDir, 'suite.json'), 'utf8')),
  );
  if (new Set(suite.tasks.map((t) => t.id)).size !== suite.tasks.length)
    throw new Error('SUITE_DUPLICATE_TASK');
  return suite;
}

/** Hashes every task definition, starting repository and acceptance check. */
export function computeLock(suiteDir: string): SuiteLock {
  const suite = loadSuite(suiteDir);
  const tasks: SuiteLock['tasks'] = {};
  for (const task of suite.tasks)
    tasks[task.id] = {
      taskHash: sha(JSON.stringify(task)),
      repoHash: treeHash(suitePath(suiteDir, task.repo)),
      checkHash: sha(readFileSync(suitePath(suiteDir, task.check))),
    };
  return {
    suiteId: suite.id,
    version: suite.version,
    tasks,
    frozenHash: sha(JSON.stringify([suite.id, suite.version, tasks])),
  };
}

/**
 * Compares the suite on disk with its committed lock. Any difference means
 * a task, repository or acceptance check changed after the freeze, so no
 * attempt may run until the suite gets a new version and a new lock.
 */
export function verifyFrozen(suiteDir: string): {
  suite: Suite;
  lock: SuiteLock;
} {
  let lock: SuiteLock;
  try {
    lock = lockSchema.parse(
      JSON.parse(readFileSync(join(suiteDir, 'suite.lock.json'), 'utf8')),
    );
  } catch {
    throw new Error('SUITE_NOT_FROZEN');
  }
  const now = computeLock(suiteDir);
  if (now.frozenHash !== lock.frozenHash) {
    const changed = Object.keys({ ...now.tasks, ...lock.tasks }).filter(
      (task) =>
        JSON.stringify(now.tasks[task]) !== JSON.stringify(lock.tasks[task]),
    );
    throw new Error(
      'SUITE_CHANGED_AFTER_FREEZE: ' +
        (changed.join(', ') || 'suite id or version'),
    );
  }
  return { suite: loadSuite(suiteDir), lock };
}

/** Problems that stop a suite from being the full v1 benchmark (plan §14). */
export function v1ShapeProblems(suite: Suite): string[] {
  const problems: string[] = [];
  const count = (test: (t: BenchmarkTask) => boolean) =>
    suite.tasks.filter(test).length;
  if (suite.tasks.length !== 24)
    problems.push('needs 24 tasks, has ' + suite.tasks.length);
  for (const category of CATEGORIES) {
    const n = count((t) => t.category === category);
    if (n !== 6) problems.push(category + ' needs 6 tasks, has ' + n);
  }
  for (const shape of ['single', 'parallel'] as const)
    if (count((t) => t.shape === shape) < 4)
      problems.push('needs at least 4 ' + shape + ' tasks');
  for (const split of ['tuning', 'held-out'] as const)
    if (count((t) => t.split === split) === 0)
      problems.push('needs ' + split + ' tasks');
  return problems;
}
