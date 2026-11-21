import { z } from 'zod';
import { phaseSuites } from './gate-policy.ts';

export const offlineCheckIds = [
  'typecheck',
  'lint',
  'format',
  'tests',
  'runtime',
  'provider-fixtures',
  'controller-roster',
  'opencode-http-permission',
  'opencode-http-interrupt',
  'opencode-http-no-auth',
  'codex-transport',
  'claude-native-stream',
  'claude-native-controller',
  'claude-native-interrupt',
  'claude-native-quota',
  'claude-create-permission',
  'claude-create-interrupt',
  'opencode-native-stream',
  'opencode-native-controller',
  'opencode-native-interrupt',
  'opencode-native-quota',
  'opencode-create-permission',
  'opencode-create-interrupt',
  'handoff-fixture',
  'tools-fixture',
  'compatibility-report',
  'browser-fixture',
  'orchestration-fixture',
  'native-loop-fixture',
  'benchmark-fixture',
  'release-audit',
] as const;

const receiptSchema = z.object({
  gateId: z.literal('G10'),
  status: z.literal('passed'),
  classification: z.literal('offline'),
  qualificationScope: z.literal('offline-release'),
  liveProvidersTested: z.array(z.never()).length(0),
  sourceRevision: z.string(),
  dirtyTreeHash: z.string(),
  checks: z.array(
    z.object({
      id: z.string(),
      exitCode: z.literal(0),
      timedOut: z.literal(false).optional(),
      expectedCount: z.number().optional(),
      observedCount: z.number().optional(),
      suites: z.record(z.string(), z.number()).optional(),
    }),
  ),
  artifacts: z.array(
    z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
});

/** Additional CI admission: a green shell step alone is insufficient. */
export function validateCiReceipt(
  input: unknown,
  revision: string,
  sourceHash: string,
) {
  const receipt = receiptSchema.parse(input);
  if (
    receipt.sourceRevision !== revision ||
    receipt.dirtyTreeHash !== sourceHash
  )
    throw new Error('Receipt does not identify the checked-out source');
  const ids = receipt.checks.map((check) => check.id);
  if (
    ids.length !== offlineCheckIds.length ||
    new Set(ids).size !== ids.length ||
    offlineCheckIds.some((id) => !ids.includes(id))
  )
    throw new Error('Missing, duplicate, or unexpected required gate check');
  const tests = receipt.checks.find((check) => check.id === 'tests')!;
  const suites = phaseSuites('10');
  const minimum = Object.values(suites).reduce((a, b) => a + b, 0);
  if (
    tests.expectedCount !== minimum ||
    (tests.observedCount ?? 0) < minimum ||
    Object.entries(suites).some(
      ([path, count]) => (tests.suites?.[path] ?? 0) < count,
    )
  )
    throw new Error('Missing or reduced required tests');
  const paths = new Set(receipt.artifacts.map((artifact) => artifact.path));
  for (const path of [
    ...offlineCheckIds.map((id) => '.artifacts/' + id + '.log'),
    '.artifacts/tests.json',
    'coverage/coverage-summary.json',
    '.artifacts/source-manifest.json',
  ])
    if (!paths.has(path)) throw new Error('Missing required artifact: ' + path);
  return receipt;
}
