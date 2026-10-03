import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync } from 'node:fs';

export interface BoundedRun {
  exitCode: number;
  timedOut: boolean;
  output: string;
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group already exited.
  }
}

// Output goes to a file, not a pipe: a descendant that outlives the stage
// cannot keep the gate waiting. On timeout the whole process tree is stopped.
export function runBounded(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; logPath: string },
): Promise<BoundedRun> {
  const fd = openSync(options.logPath, 'w');
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', fd, fd],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, options.timeoutMs);
    const finish = (exitCode: number, note: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSync(fd);
      if (note) appendFileSync(options.logPath, '\n' + note + '\n');
      resolve({
        exitCode,
        timedOut,
        output: readFileSync(options.logPath, 'utf8'),
      });
    };
    child.once('error', (error) => finish(1, error.message));
    child.once('exit', (code) =>
      timedOut
        ? finish(1, 'Timed out after ' + options.timeoutMs + ' ms')
        : finish(code ?? 1, ''),
    );
  });
}
