import { readFileSync, readlinkSync } from 'node:fs';

export interface ProcessStartIdentity {
  pid: number;
  boot: string;
  namespace: string;
  start: string;
}

function environment() {
  return {
    boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    namespace: readlinkSync('/proc/self/ns/pid'),
  };
}

function stat(pid: number) {
  const line = readFileSync('/proc/' + pid + '/stat', 'utf8');
  // The comm field can contain spaces and parentheses.
  const fields = line
    .slice(line.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  const [state, parent] = fields;
  const start = fields[19];
  if (!state || !parent || !start) throw new Error('PROCESS_STAT_INVALID');
  return { state, parent: Number(parent), start };
}

/** Capture only a child of this process in the current PID namespace. */
export function captureProcess(pid: number): ProcessStartIdentity | null {
  if (process.platform !== 'linux') return null;
  try {
    const host = environment();
    const child = stat(pid);
    if (
      child.parent !== process.pid ||
      readlinkSync('/proc/' + pid + '/ns/pid') !== host.namespace
    )
      return null;
    return { pid, ...host, start: child.start };
  } catch {
    return null;
  }
}

export function currentProcess(): ProcessStartIdentity {
  return { pid: process.pid, ...environment(), start: stat(process.pid).start };
}

export type ProcessObservation =
  'running' | 'exited' | 'pid_reused' | 'environment_changed' | 'unavailable';

/** Read-only. An exited leader does not establish that descendants or remote effects stopped. */
export function probeProcess(
  identity: ProcessStartIdentity,
): ProcessObservation {
  if (process.platform !== 'linux') return 'unavailable';
  let host: ReturnType<typeof environment>;
  try {
    host = environment();
  } catch {
    return 'unavailable';
  }
  if (host.boot !== identity.boot || host.namespace !== identity.namespace)
    return 'environment_changed';
  try {
    const current = stat(identity.pid);
    if (current.start !== identity.start) return 'pid_reused';
    if (current.state === 'Z' || current.state === 'X') return 'exited';
    return readlinkSync('/proc/' + identity.pid + '/ns/pid') ===
      identity.namespace
      ? 'running'
      : 'environment_changed';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'exited'
      : 'unavailable';
  }
}
