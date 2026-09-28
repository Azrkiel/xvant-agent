import { expect, it } from 'vitest';
import { WorkerSupervisor } from './index.ts';
const base = {
  executable: process.execPath,
  cwd: process.cwd(),
  workerId: 'worker',
  attemptId: 'attempt',
  generation: 1,
  timeoutMs: 2000,
  maxOutputBytes: 1024,
  userApprovedTrustedLocal: true,
};
it('owns stdin and streams bounded stdout until confirmed close', async () => {
  const supervisor = new WorkerSupervisor();
  const received: string[] = [];
  const run = supervisor.start({
    ...base,
    args: ['-e', "process.stdin.on('data',b=>process.stdout.write(b))"],
    interactive: { onStdout: (bytes) => received.push(bytes.toString()) },
  });
  await run.write('hello\n');
  run.endInput();
  expect(await run.result).toMatchObject({
    reason: 'exited',
    exitCode: 0,
    stdout: 'hello\n',
  });
  expect(received.join('')).toBe('hello\n');
  expect(supervisor.activeCount).toBe(0);
  await expect(run.write('late')).rejects.toThrow('CONNECTION_CLOSED');
});
it('rejects excessive input without writing it', async () => {
  const supervisor = new WorkerSupervisor();
  const run = supervisor.start({
    ...base,
    args: ['-e', 'process.stdin.resume()'],
    interactive: { onStdout: () => {} },
  });
  await expect(run.write('x'.repeat(65537))).rejects.toThrow('LIMIT_EXCEEDED');
  run.endInput();
  await run.result;
});
it('bounds streamed output and stops callback failures', async () => {
  const supervisor = new WorkerSupervisor();
  const run = supervisor.start({
    ...base,
    args: ['-e', "process.stdout.write('hello');setInterval(()=>{},1000)"],
    interactive: {
      onStdout: () => {
        throw new Error('fixture');
      },
    },
  });
  expect((await run.result).reason).toBe('cancelled');
  expect(supervisor.activeCount).toBe(0);
});
