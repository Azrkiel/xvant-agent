import { randomUUID } from 'node:crypto';
import {
  statfsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';

const limitsSchema = z.strictObject({
  delegatedCgroup: z.string().min(1),
  cpuQuotaMicros: z.number().int().min(1000).max(1_000_000),
  memoryBytes: z
    .number()
    .int()
    .min(16 * 1024 * 1024),
  processes: z.number().int().min(4).max(4096),
  scratchBytes: z
    .number()
    .int()
    .min(8192)
    .max(64 * 1024 * 1024)
    .multipleOf(8192),
});
export type LinuxWorkerLimits = z.infer<typeof limitsSchema>;

export function createLinuxWorkerCgroup(value: LinuxWorkerLimits) {
  const limits = limitsSchema.parse(value);
  const parent = limits.delegatedCgroup;
  if (
    !isAbsolute(parent) ||
    realpathSync(parent) !== parent ||
    statfsSync(parent).type !== 0x63677270
  )
    throw new Error(
      'CAPABILITY_UNSUPPORTED: use an absolute delegated cgroup v2 directory',
    );
  const group = join(parent, 'xvant-' + randomUUID());
  try {
    mkdirSync(group);
  } catch (error) {
    throw new Error(
      'CAPABILITY_UNSUPPORTED: cgroup delegation is unavailable',
      { cause: error },
    );
  }
  const write = (file: string, body: string) =>
    writeFileSync(join(group, file), body, { flag: 'r+' });
  try {
    write('cpu.max', limits.cpuQuotaMicros + ' 100000');
    write('memory.max', String(limits.memoryBytes));
    write('memory.swap.max', '0');
    write('memory.oom.group', '1');
    write('pids.max', String(limits.processes));
    write('cgroup.kill', '1'); // Fail closed before spawn if cleanup is unavailable.
  } catch (error) {
    rmdirSync(group);
    throw new Error(
      'CAPABILITY_UNSUPPORTED: the delegated cgroup needs cpu, memory, pids and kill control',
      { cause: error },
    );
  }
  return {
    // Fixed host code. Program and mount arguments are passed as argv.
    launch: [
      '-c',
      'printf "%s" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"',
      'xvant-worker',
      group,
    ],
    scratchPerMount: String(limits.scratchBytes / 2),
    async dispose() {
      write('cgroup.kill', '1');
      const deadline = performance.now() + 2000;
      do {
        const events = readFileSync(join(group, 'cgroup.events'), 'utf8');
        if (events.split('\n').includes('populated 0')) {
          rmdirSync(group);
          return;
        }
        await setTimeout(25);
      } while (performance.now() < deadline);
      throw new Error(
        'RECONCILIATION_REQUIRED: worker cgroup still populated at ' + group,
      );
    },
  };
}
