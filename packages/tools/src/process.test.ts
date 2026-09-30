import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerSupervisor } from '../../supervisor/src/index.ts';
import { ToolRegistry } from './registry.ts';
import type { ToolContext } from './registry.ts';
import { createProcessTools } from './process.ts';

const TOKEN = 'ghp_' + 'p3'.repeat(18);
let root: string;
let supervisor: WorkerSupervisor;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-process-')));
  supervisor = new WorkerSupervisor();
  writeFileSync(
    join(root, 'pass.mjs'),
    'console.log("ok " + process.cwd());\n',
  );
  writeFileSync(
    join(root, 'fail.mjs'),
    'console.error("boom"); process.exit(3);\n',
  );
});
afterEach(() => {
  supervisor.stopAll();
  rmSync(root, { recursive: true, force: true });
});
function setup(extra: Partial<ToolContext> = {}) {
  const tools = createProcessTools({
    supervisor,
    testCommands: [
      {
        id: 'unit',
        program: process.execPath,
        args: ['pass.mjs'],
        timeoutMs: 20_000,
      },
      {
        id: 'broken',
        program: process.execPath,
        args: ['fail.mjs'],
        timeoutMs: 20_000,
      },
    ],
  });
  const registry = new ToolRegistry(tools, { record: () => {} });
  const context: ToolContext = {
    projectId: 'project',
    taskId: 'task',
    attemptId: 'attempt',
    workerId: 'codex-1',
    permissionProfile: 'trusted-local',
    allowedTools: ['command.run', 'test.run'],
    approvals: [],
    now: () => 1000,
    workspace: { root, writablePaths: [] },
    ...extra,
  };
  const call = (
    tool: string,
    input: unknown,
    more: Partial<ToolContext> = {},
  ) => registry.invoke({ tool, input }, { ...context, ...more });
  return { call };
}
const approve = (actionHash: string) => ({
  approvals: [{ actionHash, decidedBy: 'owner', expiresAt: 5000 }],
});

describe('command.run', () => {
  it('runs an approved argv in the workspace without a shell', async () => {
    const { call } = setup();
    const input = { program: process.execPath, args: ['pass.mjs'] };
    const pending = await call('command.run', input);
    expect(pending.status).toBe('approval_required');
    const receipt = await call(
      'command.run',
      input,
      approve(pending.actionHash),
    );
    expect(receipt).toMatchObject({
      status: 'succeeded',
      approvedBy: 'owner',
      result: { reason: 'exited', exitCode: 0, outputTruncated: false },
    });
    expect((receipt.result as { stdout: string }).stdout.trim()).toBe(
      'ok ' + root,
    );
  });
  it.each([
    'cmd',
    'cmd.exe',
    'powershell',
    'pwsh.exe',
    'bash',
    '/bin/sh',
    'C:\\Windows\\System32\\cmd.exe',
  ])('refuses shell interpreter %s even when approved', async (program) => {
    const { call } = setup();
    const input = { program, args: ['/c', 'echo hi'] };
    const pending = await call('command.run', input);
    const receipt = await call(
      'command.run',
      input,
      approve(pending.actionHash),
    );
    expect(receipt).toMatchObject({ status: 'failed', code: 'POLICY_DENIED' });
  });
  it('stops at its deadline and redacts credential-shaped output', async () => {
    const { call } = setup();
    const slow = {
      program: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 300,
    };
    const slowPending = await call('command.run', slow);
    const timedOut = await call(
      'command.run',
      slow,
      approve(slowPending.actionHash),
    );
    expect(timedOut.result).toMatchObject({ reason: 'timeout' });
    const leak = {
      program: process.execPath,
      args: ['-e', `console.log("t=${TOKEN}")`],
    };
    const leakPending = await call('command.run', leak);
    const leaked = await call(
      'command.run',
      leak,
      approve(leakPending.actionHash),
    );
    expect((leaked.result as { stdout: string }).stdout).toContain(
      't=[REDACTED]',
    );
    expect(JSON.stringify(leaked)).not.toContain(TOKEN);
  });
  it('is unavailable to read-only profiles', async () => {
    const { call } = setup({ permissionProfile: 'read-only' });
    expect(
      (await call('command.run', { program: process.execPath, args: [] })).code,
    ).toBe('POLICY_DENIED');
  });
});

describe('test.run', () => {
  it('runs a host-registered command without per-action approval and binds the revision', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const { call } = setup();
    const receipt = await call('test.run', { commandId: 'unit' });
    expect(receipt).toMatchObject({
      status: 'succeeded',
      result: {
        commandId: 'unit',
        passed: true,
        exitCode: 0,
        revision: null,
      },
    });
    expect((receipt.result as { commandHash: string }).commandHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
  it('reports failures and refuses unregistered commands', async () => {
    const { call } = setup();
    expect(await call('test.run', { commandId: 'broken' })).toMatchObject({
      status: 'succeeded',
      result: { passed: false, exitCode: 3 },
    });
    expect((await call('test.run', { commandId: 'rm-rf' })).code).toBe(
      'NOT_FOUND',
    );
    expect(
      (await call('test.run', { commandId: 'unit', program: 'x' })).code,
    ).toBe('INVALID_INPUT');
  });
});
