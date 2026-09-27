import { describe, expect, it } from 'vitest';
import { WorkerSupervisor } from './index.ts';
import { executionCapabilities } from '../../policy/src/index.ts';

const command = (source: string) => ({
  executable: process.execPath,
  args: ['-e', source],
  cwd: process.cwd(),
  workerId: 'worker-1',
  attemptId: 'attempt-1',
  generation: 1,
  timeoutMs: 1500,
  maxOutputBytes: 128,
  userApprovedTrustedLocal: true,
});
describe('owned process supervision', () => {
  it('captures exit and bounded combined output without shell evaluation', async () => {
    const supervisor = new WorkerSupervisor();
    const run = supervisor.start(
      command(
        "process.stdout.write('x'.repeat(1000)); process.stderr.write('err')",
      ),
    );
    const result = await run.result;
    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(128);
    expect(result.outputTruncated).toBe(true);
    expect(supervisor.activeCount).toBe(0);
  });
  it('hard deadline kills a worker that does not cooperate', async () => {
    const supervisor = new WorkerSupervisor();
    const run = supervisor.start({
      ...command('setInterval(() => {}, 1000)'),
      timeoutMs: 150,
    });
    expect((await run.result).reason).toBe('timeout');
    expect(supervisor.activeCount).toBe(0);
  });
  it('rejects forged identity and accepts owned cancellation', async () => {
    const supervisor = new WorkerSupervisor();
    const run = supervisor.start(command('setInterval(() => {}, 1000)'));
    expect(supervisor.cancel({ ...run.identity, nonce: 'forged' })).toBe(false);
    expect(supervisor.cancel(run.identity)).toBe(true);
    expect((await run.result).reason).toBe('cancelled');
    expect(supervisor.cancel(run.identity)).toBe(false);
  });
  it('abort interrupts active execution', async () => {
    const abort = new AbortController();
    const run = new WorkerSupervisor().start({
      ...command('setInterval(() => {}, 1000)'),
      signal: abort.signal,
    });
    abort.abort();
    expect((await run.result).reason).toBe('cancelled');
  });
  it('refuses unapproved, invalid, and already aborted execution before spawning', () => {
    const supervisor = new WorkerSupervisor();
    expect(() =>
      supervisor.start({ ...command(''), userApprovedTrustedLocal: false }),
    ).toThrow();
    expect(() => supervisor.start({ ...command(''), timeoutMs: 0 })).toThrow();
    expect(() =>
      supervisor.start({ ...command(''), signal: AbortSignal.abort() }),
    ).toThrow();
    expect(supervisor.activeCount).toBe(0);
  });
  it('reports spawn failure without hanging', async () => {
    const run = new WorkerSupervisor().start({
      ...command(''),
      executable: 'missing-xvant-executable',
    });
    expect((await run.result).reason).toBe('spawn_failed');
  });
});

it('terminates the owned ordinary descendant tree on deadline', async () => {
  const source =
    "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); setInterval(()=>{},1000)";
  const run = new WorkerSupervisor().start({
    ...command(source),
    timeoutMs: 500,
  });
  const result = await run.result;
  expect(result.reason).toBe('timeout');
  const descendantPid = Number(result.stdout);
  expect(descendantPid).toBeGreaterThan(0);
  await expect
    .poll(
      () => {
        try {
          process.kill(descendantPid, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 2000 },
    )
    .toBe(false);
});

it('global stop interrupts every owned process and rejects stale generations', async () => {
  const supervisor = new WorkerSupervisor();
  const first = supervisor.start(command('setInterval(()=>{},1000)'));
  const second = supervisor.start(command('setInterval(()=>{},1000)'));
  expect(supervisor.cancel({ ...first.identity, generation: 2 })).toBe(false);
  expect(supervisor.cancel({ ...first.identity, workerId: 'other' })).toBe(
    false,
  );
  expect(supervisor.cancel({ ...first.identity, startedAt: 0 })).toBe(false);
  supervisor.stopAll();
  expect(
    (await Promise.all([first.result, second.result])).map(
      (value) => value.reason,
    ),
  ).toEqual(['cancelled', 'cancelled']);
});

it('bounds arbitrary non-UTF8 output after decoding', async () => {
  const result = await new WorkerSupervisor().start({
    ...command('process.stdout.write(Buffer.alloc(128,255))'),
    maxOutputBytes: 128,
  }).result;
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
});

it('returns bounded needs_attention when an exited root leaves inherited pipes open', async () => {
  if (process.platform !== 'linux') {
    expect(executionCapabilities().processTreeContainment).toBe(false);
    return;
  }
  // The fixture self-terminates; the supervisor must never kill a recycled root PID.
  const source =
    "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:['ignore',1,2]}); process.exit(0)";
  const result = await new WorkerSupervisor().start({
    ...command(source),
    timeoutMs: 150,
  }).result;
  expect(result.reason).toBe('needs_attention');
  expect(result.treeContainment).toBe(false);
}, 10000);

it('retains ownership after uncertain shutdown so cancellation can be retried', async () => {
  const supervisor = new WorkerSupervisor();
  if (process.platform !== 'win32') {
    expect(executionCapabilities().processTreeContainment).toBe(false);
    return;
  }
  const originalRoot = process.env.SystemRoot;
  // A finite worker prevents a leaked fixture if this regression fails.
  const run = supervisor.start({
    ...command('setTimeout(()=>{},8500)'),
    timeoutMs: 100,
  });
  process.env.SystemRoot = 'missing-system-root';
  try {
    expect((await run.result).reason).toBe('needs_attention');
  } finally {
    if (originalRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalRoot;
  }
  expect(supervisor.activeCount).toBe(1);
  expect(supervisor.cancel(run.identity)).toBe(true);
  await expect.poll(() => supervisor.activeCount, { timeout: 2000 }).toBe(0);
}, 10000);
