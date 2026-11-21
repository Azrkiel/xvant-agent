/** Fresh controller process used by the offline workflow crash tests. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { WorkerSupervisor } from '../../packages/supervisor/src/index.ts';
import { Store } from '../../packages/storage/src/store.ts';
import {
  Orchestrator,
  type TurnRunner,
  type WorkerSpec,
} from '../../apps/controller/src/orchestrator.ts';

const [root, operation, lease, stopAt, runId = 'root'] = process.argv.slice(
  2,
) as string[];
if (!root || !operation || !lease) throw new Error('FIXTURE_INVALID');
const repository = join(root, 'repo');
const calls = join(root, 'effects.log');
const store = new Store(join(root, 'state.sqlite'), {
  owner: 'process-' + lease,
  now: () => Number(lease) * 100000,
  recoverWorkGraphs: true,
  fault: (point) => {
    if (point === stopAt) {
      appendFileSync(2, 'Forced termination at ' + point + '\n');
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
const workers: WorkerSpec[] = [
  {
    alias: 'worker',
    runtimeKind: 'native-local',
    quotaGroupId: 'worker',
    roles: ['worker', 'planner'],
  },
  {
    alias: 'reviewer',
    runtimeKind: 'native-local',
    quotaGroupId: 'reviewer',
    roles: ['reviewer'],
  },
];
const runner: TurnRunner = {
  interrupt: () => false,
  run: async ({ taskId, workspace }, execution) => {
    appendFileSync(calls, 'turn ' + taskId + '\n');
    if (
      taskId.includes('-first-') &&
      (stopAt === 'hold-worker' || stopAt === 'hold-unidentified-worker')
    ) {
      await new WorkerSupervisor().start({
        executable: process.execPath,
        args: [
          '-e',
          'const fs = require("node:fs"); fs.writeFileSync("partial.txt", "partial"); ' +
            'fs.writeFileSync(process.argv[1], String(process.pid)); ' +
            'const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) clearInterval(timer) }, 20);',
          join(root, 'worker-started'),
          join(root, 'worker-release'),
        ],
        cwd: workspace.path,
        workerId: 'worker',
        attemptId: execution!.attemptId,
        generation: 1,
        timeoutMs: 10_000,
        maxOutputBytes: 1024,
        userApprovedTrustedLocal: true,
        onProcess: stopAt === 'hold-worker' ? execution!.onProcess : undefined,
      }).result;
      appendFileSync(calls, 'late ' + taskId + '\n');
    }
    const empty = { status: 'accepted' as const, files: [], patch: null };
    if (taskId.includes('-plan-'))
      return {
        ...empty,
        finalText: JSON.stringify({
          summary: 'Two ordered nodes',
          nodes: [
            {
              id: 'first',
              title: 'First',
              objective: 'Modify the first file',
              acceptanceCriteria: ['First changes'],
              writablePaths: ['a.txt'],
            },
            {
              id: 'second',
              title: 'Second',
              objective: 'Modify the second file',
              acceptanceCriteria: ['Second changes'],
              writablePaths: ['b.txt'],
              dependsOn: ['first'],
            },
          ],
        }),
      };
    if (taskId.includes('-review-') && !taskId.includes('-review-fix-')) {
      const ok =
        readFileSync(join(workspace.path, 'b.txt'), 'utf8') === 'reviewed\n';
      return {
        ...empty,
        finalText: JSON.stringify({
          approve: ok,
          findings: ok ? [] : ['Update the second file'],
        }),
      };
    }
    const [file, content] = taskId.includes('-review-fix-')
      ? ['b.txt', 'reviewed']
      : taskId.includes('-fix-')
        ? ['a.txt', 'verified']
        : taskId.includes('-first-')
          ? ['a.txt', 'first']
          : ['b.txt', 'second'];
    writeFileSync(join(workspace.path, file), content + '\n');
    return {
      ...empty,
      finalText: content,
      files: [file],
      patch: execFileSync('git', ['diff', '--binary', '--full-index'], {
        cwd: workspace.path,
      }),
    };
  },
};
const controller = new Orchestrator(store, runner, workers, {
  stateRoot: join(root, 'runs'),
  runtimeBindings: {},
});
try {
  const result =
    operation === 'start'
      ? await controller.run({
          id: runId,
          projectId: 'fixture',
          repository,
          baseRevision: 'HEAD',
          objective: 'Complete both ordered nodes',
          acceptanceCriteria: ['Files pass check and review'],
          checks: {
            verify: {
              executable: process.execPath,
              args: [
                '-e',
                'const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "check\\n"); ' +
                  'if (fs.readFileSync("a.txt", "utf8").trim() !== "verified") process.exit(1);',
                calls,
              ],
            },
          },
          maxActive: 2,
          maxRepairs: 1,
          maxReviewRepairs: 1,
          checkTimeoutMs: 30000,
        })
      : await controller.resume(runId);
  console.log(JSON.stringify(result));
} finally {
  store.close();
}
