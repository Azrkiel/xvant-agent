import { z } from 'zod';
import { providerKindSchema } from '../packages/contracts/src/providers.ts';
import type { ProviderKind } from '../packages/contracts/src/providers.ts';

export type VersionResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
};
export function probeInventory(
  input: unknown,
  execute: (kind: ProviderKind) => VersionResult,
) {
  const parsed = z
    .array(providerKindSchema)
    .min(1)
    .max(3)
    .refine((v) => new Set(v).size === v.length)
    .safeParse(input);
  if (!parsed.success) throw new Error('INVALID_INPUT');
  const providers = parsed.data.map((runtimeKind) => {
    const result = execute(runtimeKind);
    // Emit a version only. Raw stdout/stderr may contain account data or credentials.
    const match = result.stdout
      .trim()
      .match(
        /^(?:codex-cli |codex |claude |opencode )?v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?: \(Claude Code\))?$/,
      );
    const status =
      result.errorCode === 'ENOENT'
        ? 'unavailable'
        : result.status === 0 && match
          ? 'passed'
          : 'failed';
    return {
      runtimeKind,
      status,
      runtimeVersion: status === 'passed' ? match![1]! : null,
      liveEnabled: false,
      auth: 'untested',
      billing: 'unknown',
    };
  });
  const exitCode = providers.some((p) => p.status === 'failed')
    ? 1
    : providers.some((p) => p.status === 'unavailable')
      ? 2
      : 0;
  return {
    classification: 'inventory-only',
    liveProvidersTested: [],
    providers,
    exitCode,
  };
}
