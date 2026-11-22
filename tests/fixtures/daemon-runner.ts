import {
  appendFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { AppOptions } from '../../apps/controller/src/app.ts';
import { WorkerSupervisor } from '../../packages/supervisor/src/index.ts';

const folder = process.env.XVANT_DAEMON_FIXTURE_DIR!;
const supervisor = new WorkerSupervisor();
const handles = new Map<
  string,
  ReturnType<typeof supervisor.start>['identity']
>();
const task = {
  id: 'change',
  title: 'Check the fixture',
  objective: 'Produce a verified no-op',
  acceptanceCriteria: ['Fixture completed'],
  writablePaths: ['test.txt'],
};

export const managerVerifier = {
  checks: {
    fixture: {
      executable: process.execPath,
      args: [
        '-e',
        "if (require('node:fs').readFileSync('work/fix.txt', 'utf8') !== 'fixed') process.exit(1)",
      ],
    },
  },
  checkTimeoutMs: 5000,
};
export default {
  managerVerifier,
  discover: (kind) => ({
    runtimeKind: kind,
    status: 'qualified',
    executable: process.execPath,
    version: 'daemon-fixture-1',
    expectedVersion: 'daemon-fixture-1',
    candidates: 1,
  }),
  runner: () => ({
    run: async (request, execution) => {
      if (request.taskId.startsWith('manager_')) {
        const cwd = request.workspace.path;
        const fix =
          request.taskId.includes('-check-repair-') ||
          request.prompt.startsWith('The combined work');
        const review = request.prompt.startsWith('Review this change');
        const path = review
          ? null
          : fix
            ? 'work/fix.txt'
            : request.writablePaths?.[0];
        appendFileSync(
          join(folder, 'calls'),
          JSON.stringify({
            taskId: request.taskId,
            alias: request.alias,
            operationId: execution?.operationId,
            attemptId: execution?.attemptId,
            path,
          }) + '\n',
        );
        const killMarker = join(folder, 'manager-kill-enabled');
        if (path === 'work/second.txt' && existsSync(killMarker)) {
          unlinkSync(killMarker);
          const child = supervisor.start({
            executable: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            cwd,
            workerId: request.alias,
            attemptId: request.taskId,
            generation: 1,
            timeoutMs: 12_000,
            maxOutputBytes: 2048,
            userApprovedTrustedLocal: true,
            onProcess: (identity) => {
              execution?.onProcess(identity);
              writeFileSync(
                join(folder, 'manager-worker.json'),
                JSON.stringify(identity),
              );
            },
          });
          const ended = await child.result;
          return {
            status:
              ended.reason === 'exited' && ended.exitCode === null
                ? 'failed'
                : 'unknown',
            finalText: '',
            files: [],
            patch: null,
            failure: 'FIXTURE_WORKER_DIED',
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!path)
          return {
            status: review ? 'accepted' : 'failed',
            finalText: '{"approve":true,"findings":[]}',
            files: [],
            patch: null,
          };
        mkdirSync(join(cwd, 'work'), { recursive: true });
        writeFileSync(join(cwd, path), fix ? 'fixed' : 'fixture');
        execFileSync('git', ['add', '--', path], { cwd });
        const patch = execFileSync(
          'git',
          ['diff', '--cached', '--binary', 'HEAD', '--', path],
          { cwd },
        );
        return {
          status: 'accepted',
          finalText: 'fixture result',
          files: [path],
          patch,
        };
      }
      const planning = request.taskId.includes('-plan-');
      const held = planning && request.prompt.includes('hold-root');
      const child = supervisor.start({
        executable: process.execPath,
        args: [
          '-e',
          `
          const { existsSync, writeFileSync } = require('node:fs');
          const timer = setInterval(() => {
            if (existsSync(process.argv[1])) {
              writeFileSync(process.argv[1] + '.finished', '');
              clearInterval(timer);
            }
          }, 25);
          setTimeout(() => { clearInterval(timer); process.exit(1); }, 12_000).unref();
        `,
          join(folder, 'release-' + request.taskId),
        ],
        cwd: request.workspace.path,
        workerId: request.alias,
        attemptId: request.taskId,
        generation: 1,
        ...(execution ? { onProcess: execution.onProcess } : {}),
        timeoutMs: 12_000,
        maxOutputBytes: 2048,
        userApprovedTrustedLocal: true,
      });
      handles.set(request.taskId, child.identity);
      appendFileSync(
        join(folder, 'calls'),
        JSON.stringify({
          taskId: request.taskId,
          alias: request.alias,
          operationId: execution?.operationId,
          attemptId: execution?.attemptId,
        }) + '\n',
      );
      if (!held) writeFileSync(join(folder, 'release-' + request.taskId), '');
      const result = await child.result.finally(() =>
        handles.delete(request.taskId),
      );
      return {
        status:
          result.reason === 'exited' && result.exitCode === 0
            ? 'accepted'
            : result.reason === 'cancelled'
              ? 'cancelled'
              : 'unknown',
        finalText: planning
          ? JSON.stringify({ summary: 'fixture', nodes: [task] })
          : 'verified no-op',
        files: [],
        patch: planning ? null : Buffer.alloc(0),
      };
    },
    interrupt: (id) => {
      const handle = handles.get(id);
      return handle ? supervisor.cancel(handle) : false;
    },
  }),
} satisfies Pick<AppOptions, 'discover' | 'runner' | 'managerVerifier'>;
