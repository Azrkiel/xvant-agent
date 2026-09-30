import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  DomainError,
  hashSchema,
  idSchema,
} from '../../contracts/src/index.ts';
import { revisionSchema } from '../../contracts/src/context.ts';
import { canonicalJson, sha256 } from '../../context/src/packet.ts';
import { redactSecrets } from '../../context/src/secrets.ts';
import type {
  ProcessResult,
  WorkerSupervisor,
} from '../../supervisor/src/index.ts';
import { defineTool } from './registry.ts';
import type { ToolContext } from './registry.ts';
import { workspaceRoot } from './workspace.ts';

/** A repository-approved command; registration by the host is its approval. */
export interface TestCommand {
  id: string;
  program: string;
  args: readonly string[];
  timeoutMs: number;
}
const SHELLS = new Set([
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'dash',
  'fish',
  'wsl',
  'csh',
  'ksh',
]);
const MAX_OUTPUT = 256 * 1024;
const processOutput = {
  reason: z.enum([
    'exited',
    'timeout',
    'cancelled',
    'spawn_failed',
    'needs_attention',
  ]),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean(),
};
async function supervised(
  supervisor: WorkerSupervisor,
  context: ToolContext,
  command: { program: string; args: readonly string[]; timeoutMs: number },
  signal: AbortSignal,
) {
  const run = supervisor.start({
    executable: command.program,
    args: [...command.args],
    cwd: workspaceRoot(context),
    workerId: context.workerId,
    attemptId: context.attemptId,
    generation: 1,
    timeoutMs: command.timeoutMs,
    maxOutputBytes: MAX_OUTPUT,
    // Reached only after authorizeTool admitted this exact action.
    userApprovedTrustedLocal: true,
    signal,
  });
  run.endInput();
  const result: ProcessResult = await run.result;
  return {
    reason: result.reason,
    exitCode: result.exitCode,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    outputTruncated: result.outputTruncated,
  };
}
function revision(root: string): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', '-q', 'HEAD'],
      { cwd: root, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        const value = stdout?.trim() ?? '';
        resolve(
          !error && revisionSchema.safeParse(value).success ? value : null,
        );
      },
    ),
  );
}

/**
 * Process tools run through the owned supervisor: no shell, hard deadline,
 * bounded output, owned-tree termination. This is trusted-local execution,
 * not a sandbox; profiles that require isolation never admit these tools.
 */
export function createProcessTools(services: {
  supervisor: WorkerSupervisor;
  testCommands: readonly TestCommand[];
}) {
  const commands = new Map(
    services.testCommands.map((command) => {
      if (!idSchema.safeParse(command.id).success)
        throw new DomainError('INVALID_INPUT', 'Invalid test command id');
      return [
        command.id,
        Object.freeze({ ...command, args: [...command.args] }),
      ];
    }),
  );
  const commandRun = defineTool({
    manifest: {
      name: 'command.run',
      version: '1.0.0',
      description:
        'Run one approved program with an argument vector in the workspace. Shell interpreters are refused.',
      effect: 'process',
      permissions: ['process.run'],
      host: 'workspace',
      timeoutMs: 600_000,
      retry: 'unsafe',
      maxResultBytes: 2 * 1024 * 1024,
    },
    input: z.strictObject({
      program: z.string().min(1).max(1024),
      args: z.array(z.string().max(8192)).max(64),
      timeoutMs: z.number().int().min(1).max(590_000).optional(),
    }),
    output: z.strictObject(processOutput),
    execute: async (input, context, signal) => {
      const name = basename(input.program.replaceAll('\\', '/'))
        .toLowerCase()
        .replace(/\.(exe|cmd|bat|com)$/, '');
      if (SHELLS.has(name))
        throw new DomainError(
          'POLICY_DENIED',
          'Shell interpreters would re-parse argument strings',
        );
      return supervised(
        services.supervisor,
        context,
        { ...input, timeoutMs: input.timeoutMs ?? 120_000 },
        signal,
      );
    },
  });
  const testRun = defineTool({
    manifest: {
      name: 'test.run',
      version: '1.0.0',
      description:
        'Run a repository-approved test command by id. The result records the command hash and source revision.',
      effect: 'process',
      permissions: ['process.run'],
      host: 'workspace',
      timeoutMs: 600_000,
      retry: 'unsafe',
      maxResultBytes: 2 * 1024 * 1024,
      preapproved: true,
    },
    input: z.strictObject({ commandId: idSchema }),
    output: z.strictObject({
      commandId: idSchema,
      commandHash: hashSchema,
      revision: revisionSchema.nullable(),
      passed: z.boolean(),
      ...processOutput,
    }),
    execute: async (input, context, signal) => {
      const command = commands.get(input.commandId);
      if (!command)
        throw new DomainError('NOT_FOUND', 'No such registered test command');
      const root = workspaceRoot(context);
      const source = await revision(root);
      const result = await supervised(
        services.supervisor,
        context,
        command,
        signal,
      );
      return {
        commandId: command.id,
        commandHash: sha256(
          canonicalJson({ program: command.program, args: command.args }),
        ),
        revision: source,
        passed: result.reason === 'exited' && result.exitCode === 0,
        ...result,
      };
    },
  });
  return [commandRun, testRun];
}
