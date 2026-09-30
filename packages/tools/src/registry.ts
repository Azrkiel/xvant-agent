import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../contracts/src/index.ts';
import {
  toolManifestSchema,
  toolNameSchema,
} from '../../contracts/src/tools.ts';
import type {
  ToolApproval,
  ToolManifest,
  ToolReceipt,
} from '../../contracts/src/tools.ts';
import { authorizeTool } from '../../policy/src/tools.ts';
import { canonicalJson, sha256 } from '../../context/src/packet.ts';

/**
 * Host-owned scope for one invocation. Workers never supply it; tool results
 * cannot change it, so retrieved text cannot widen a catalog or approve itself.
 */
export interface ToolContext {
  projectId: string;
  taskId: string;
  attemptId: string;
  workerId: string;
  permissionProfile: string;
  allowedTools: readonly string[];
  approvals: readonly ToolApproval[];
  now: () => number;
  /** Canonical workspace for file and process tools; absent for controller-only tools. */
  workspace?: {
    root: string;
    writablePaths: readonly string[];
    baseRevision?: string;
  };
}
export interface ToolDefinition<I = unknown, O = unknown> {
  manifest: ToolManifest;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  execute(input: I, context: ToolContext, signal: AbortSignal): Promise<O>;
  /** Content hashes the tool produced, recorded on the receipt. */
  artifacts?(output: O): string[];
}
export function defineTool<I, O>(
  definition: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  const manifest = toolManifestSchema.safeParse(definition.manifest);
  if (!manifest.success)
    throw new DomainError('INVALID_INPUT', 'Invalid tool manifest');
  return Object.freeze({
    ...definition,
    manifest: Object.freeze(manifest.data),
  });
}
/** Stable hash of one action: tool, version, task, attempt and normalized input. */
export function actionHash(
  manifest: Pick<ToolManifest, 'name' | 'version'>,
  context: Pick<ToolContext, 'projectId' | 'taskId' | 'attemptId'>,
  input: unknown,
): string {
  return sha256(
    canonicalJson({
      tool: manifest.name,
      version: manifest.version,
      projectId: context.projectId,
      taskId: context.taskId,
      attemptId: context.attemptId,
      input,
    }),
  );
}
const TIMED_OUT = Symbol('timeout');
function errorCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  // Storage and path helpers throw bare upper-case codes.
  if (error instanceof Error && /^[A-Z][A-Z_]{2,63}$/.test(error.message))
    return error.message;
  return 'TOOL_FAILED';
}

/**
 * Executes registered tools behind one policy gate. Every outcome, including
 * denial, produces a receipt bound to the host context and action hash.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #record: (receipt: ToolReceipt) => void;
  constructor(
    tools: readonly ToolDefinition[],
    options: { record: (receipt: ToolReceipt) => void },
  ) {
    for (const tool of tools) {
      if (this.#tools.has(tool.manifest.name))
        throw new DomainError('DUPLICATE_IDENTITY', 'Duplicate tool name');
      this.#tools.set(tool.manifest.name, tool);
    }
    this.#record = options.record;
  }
  manifests(): (ToolManifest & {
    inputSchema: unknown;
    outputSchema: unknown;
  })[] {
    return [...this.#tools.values()].map((tool) => ({
      ...tool.manifest,
      inputSchema: z.toJSONSchema(tool.input as z.ZodType),
      outputSchema: z.toJSONSchema(tool.output as z.ZodType),
    }));
  }
  async invoke(
    request: { tool: string; input: unknown },
    context: ToolContext,
  ): Promise<ToolReceipt> {
    const startedAt = context.now();
    const tool = toolNameSchema.safeParse(request.tool).success
      ? this.#tools.get(request.tool)
      : undefined;
    const identity = {
      name: tool?.manifest.name ?? 'unknown',
      version: tool?.manifest.version ?? '0.0.0',
    };
    const finish = (
      fields: Pick<ToolReceipt, 'status'> & Partial<ToolReceipt>,
      input: unknown = request.input,
    ): ToolReceipt => {
      const receipt: ToolReceipt = {
        receiptId: randomUUID(),
        tool: identity.name,
        version: identity.version,
        projectId: context.projectId,
        taskId: context.taskId,
        attemptId: context.attemptId,
        workerId: context.workerId,
        actionHash: actionHash(identity, context, input),
        startedAt,
        finishedAt: context.now(),
        ...fields,
      };
      this.#record(receipt);
      return receipt;
    };
    if (!tool || !context.allowedTools.includes(tool.manifest.name))
      return finish({
        status: 'denied',
        code: 'POLICY_DENIED',
        message: 'Tool is not in this task catalog',
      });
    const parsed = tool.input.safeParse(request.input);
    if (!parsed.success)
      return finish({
        status: 'failed',
        code: 'INVALID_INPUT',
        message: 'Input does not match the tool schema',
      });
    const input = parsed.data;
    const decision = authorizeTool({
      manifest: tool.manifest,
      allowedTools: context.allowedTools,
      profile: context.permissionProfile,
      actionHash: actionHash(tool.manifest, context, input),
      approvals: context.approvals,
      now: startedAt,
    });
    if (!decision.allowed)
      return finish(
        {
          status:
            decision.code === 'APPROVAL_REQUIRED'
              ? 'approval_required'
              : 'denied',
          code: decision.code,
          message: decision.reason,
        },
        input,
      );
    const approved = decision.approvedBy
      ? { approvedBy: decision.approvedBy }
      : {};
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output: unknown;
    try {
      output = await Promise.race([
        tool.execute(input, context, controller.signal),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => {
            // Settle first, so a tool rejecting on abort cannot mask the timeout.
            resolve(TIMED_OUT);
            controller.abort();
          }, tool.manifest.timeoutMs);
        }),
      ]);
    } catch (error) {
      return finish(
        { status: 'failed', code: errorCode(error), ...approved },
        input,
      );
    } finally {
      clearTimeout(timer);
    }
    if (output === TIMED_OUT)
      return finish(
        {
          status: 'timeout',
          code: 'TIMEOUT',
          message: 'Tool exceeded its deadline',
          ...approved,
        },
        input,
      );
    const checked = tool.output.safeParse(output);
    if (!checked.success)
      return finish(
        {
          status: 'failed',
          code: 'TOOL_FAILED',
          message: 'Tool produced an invalid result',
          ...approved,
        },
        input,
      );
    if (
      Buffer.byteLength(JSON.stringify(checked.data), 'utf8') >
      tool.manifest.maxResultBytes
    )
      return finish(
        {
          status: 'failed',
          code: 'LIMIT_EXCEEDED',
          message: 'Result exceeds the tool limit',
          ...approved,
        },
        input,
      );
    const artifacts = tool.artifacts?.(checked.data);
    return finish(
      {
        status: 'succeeded',
        result: checked.data,
        ...approved,
        ...(artifacts?.length ? { artifacts } : {}),
      },
      input,
    );
  }
}
