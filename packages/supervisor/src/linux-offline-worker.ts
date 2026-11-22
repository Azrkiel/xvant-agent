import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  createLinuxWorkerCgroup,
  type LinuxWorkerLimits,
} from './linux-worker-limits.ts';
import { WorkerSupervisor, type ProcessRequest } from './index.ts';

const launcher = '/usr/bin/bwrap';
const mountPoints = ['input', 'workspace', 'proc', 'dev', 'tmp'];
const scratchBytes = String(32 * 1024 * 1024);

export interface LinuxOfflineRequest extends Pick<
  ProcessRequest,
  | 'args'
  | 'workerId'
  | 'attemptId'
  | 'generation'
  | 'timeoutMs'
  | 'maxOutputBytes'
  | 'signal'
> {
  /** Trusted, dedicated runtime image prepared by the host operator. */
  runtimeRoot: string;
  /** Dedicated staged input, containing only material granted to this job. */
  stagedInput: string;
  /** Executable basename in the trusted runtime image's /usr/bin. */
  program: string;
  operatorApproved: boolean;
  /** Optional delegated cgroup enforcement for the offline profile. */
  limits?: LinuxWorkerLimits;
  /** Provider profiles require a qualified launcher and are currently unavailable. */
  profile?: 'offline' | 'codex' | 'claude' | 'opencode';
}

function directory(path: string): string {
  if (!isAbsolute(path))
    throw new Error('INVALID_INPUT: absolute staging paths are required');
  const canonical = realpathSync(path);
  if (canonical === '/' || !statSync(canonical).isDirectory())
    throw new Error('INVALID_INPUT: a dedicated staging directory is required');
  return canonical;
}

/** Start the credential-free qualification profile. Failure never runs the worker on the host. */
export function startLinuxOfflineWorker(
  supervisor: WorkerSupervisor,
  request: LinuxOfflineRequest,
): ReturnType<WorkerSupervisor['start']> {
  if (request.operatorApproved !== true)
    throw new Error(
      'POLICY_DENIED: offline worker launch requires operator approval',
    );
  if (process.platform !== 'linux')
    throw new Error(
      'CAPABILITY_UNSUPPORTED: Linux offline worker requires Linux',
    );
  if (request.profile !== undefined && request.profile !== 'offline')
    throw new Error(
      'CAPABILITY_UNSUPPORTED: no qualified isolated profile for ' +
        request.profile,
    );
  const executable = statSync(launcher, { throwIfNoEntry: false });
  if (!executable?.isFile() || executable.uid !== 0 || executable.mode & 0o6022)
    throw new Error(
      'CAPABILITY_UNSUPPORTED: install a system-managed, unprivileged bubblewrap at ' +
        launcher,
    );

  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(request.program))
    throw new Error('INVALID_INPUT: use an executable basename from /usr/bin');
  const runtimeRoot = directory(request.runtimeRoot);
  const stagedInput = directory(request.stagedInput);
  if (
    [
      relative(runtimeRoot, stagedInput),
      relative(stagedInput, runtimeRoot),
    ].some((path) => path !== '..' && !path.startsWith('../'))
  )
    throw new Error('INVALID_INPUT: runtime and staged input must be disjoint');
  for (const point of mountPoints) {
    if (
      !lstatSync(join(runtimeRoot, point), {
        throwIfNoEntry: false,
      })?.isDirectory()
    )
      throw new Error('INVALID_INPUT: runtime needs a directory at /' + point);
  }

  const cgroup = request.limits
    ? createLinuxWorkerCgroup(request.limits)
    : undefined;
  const size = cgroup?.scratchPerMount ?? scratchBytes;
  const options: ProcessRequest = {
    executable: cgroup ? '/bin/sh' : launcher,
    cwd: '/',
    args: [
      ...(cgroup ? [...cgroup.launch, launcher] : []),
      '--unshare-all',
      '--unshare-user',
      '--unshare-cgroup',
      '--disable-userns',
      '--assert-userns-disabled',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--clearenv',
      '--setenv',
      'PATH',
      '/usr/bin:/bin',
      '--setenv',
      'HOME',
      '/tmp',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'LANG',
      'C',
      '--ro-bind',
      runtimeRoot,
      '/',
      '--ro-bind',
      stagedInput,
      '/input',
      '--size',
      size,
      '--tmpfs',
      '/workspace',
      '--size',
      size,
      '--tmpfs',
      '/tmp',
      '--proc',
      '/proc',
      '--remount-ro',
      '/proc',
      '--dev',
      '/dev',
      ...(cgroup ? ['--remount-ro', '/dev'] : []),
      '--chdir',
      '/workspace',
      '--',
      '/usr/bin/' + request.program,
      ...request.args,
    ],
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    inheritEnv: false,
    workerId: request.workerId,
    attemptId: request.attemptId,
    generation: request.generation,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
    ...(request.signal ? { signal: request.signal } : {}),
    userApprovedTrustedLocal: true,
  };
  if (!cgroup) return supervisor.start(options);
  // Preserve the exact supervisor identity while withholding completion until
  // the kernel reports the scope empty.
  let handle: ReturnType<WorkerSupervisor['start']>;
  try {
    handle = supervisor.start(options);
  } catch (error) {
    // No child can have started on a synchronous validation error.
    void cgroup.dispose().catch(() => {});
    throw error;
  }
  return { ...handle, result: handle.result.finally(() => cgroup.dispose()) };
}
