import { z } from 'zod';
const reportSchema = z.object({
  success: z.literal(true),
  numTotalTests: z.number().int().positive(),
  numPassedTests: z.number().int().positive(),
  numFailedTests: z.literal(0),
  numPendingTests: z.literal(0),
  numTodoTests: z.literal(0),
  testResults: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.literal('passed'),
        assertionResults: z
          .array(z.object({ status: z.literal('passed') }))
          .min(1),
      }),
    )
    .min(1),
});
export function validateTestReport(
  input: unknown,
  minimums: Readonly<Record<string, number>>,
): { total: number; suites: Record<string, number> } {
  const expected = z
    .record(z.string().min(1), z.number().int().positive())
    .parse(minimums);
  if (!Object.keys(expected).length) throw new Error('No expected test suites');
  const report = reportSchema.parse(input);
  const observed = new Map<string, number>();
  for (const suite of report.testResults) {
    const name = suite.name.replaceAll('\\', '/');
    if (observed.has(name)) throw new Error('Duplicate suite identity');
    observed.set(name, suite.assertionResults.length);
  }
  const total = [...observed.values()].reduce((sum, count) => sum + count, 0);
  if (total !== report.numTotalTests || total !== report.numPassedTests)
    throw new Error('Inconsistent test totals');
  const suites: Record<string, number> = {};
  for (const [path, min] of Object.entries(expected)) {
    const matching = [...observed.entries()].filter(
      ([name]) => name === path || name.endsWith('/' + path),
    );
    if (matching.length !== 1 || matching[0]![1] < min)
      throw new Error('Missing or reduced suite: ' + path);
    suites[path] = matching[0]![1];
  }
  return { total, suites };
}
export function phaseSuites(phase: string): Record<string, number> {
  if (!['01', '02', '03', '04', '05'].includes(phase))
    throw new Error('Unsupported gate phase');
  const baseline: Record<string, number> = {
    'packages/contracts/src/contracts.test.ts': 15,
    'packages/core/src/task.test.ts': 26,
    'packages/core/src/graph.test.ts': 20,
    'packages/adapters/src/simulated/simulated.test.ts': 10,
    'apps/controller/src/controller.test.ts': 24,
    'tests/gate.test.ts': 16,
  };
  return phase === '01'
    ? baseline
    : {
        ...baseline,
        'packages/storage/src/store.test.ts': 20,
        'packages/storage/src/artifacts.test.ts': 20,
        'packages/supervisor/src/index.test.ts': 12,
        'packages/policy/src/index.test.ts': 2,
        'apps/controller/src/durable.test.ts': 13,
        'apps/controller/src/service.test.ts': 3,
        'apps/controller/src/http/server.test.ts': 11,
        'tests/faults/crash.test.ts': 7,
        ...(['03', '04', '05'].includes(phase)
          ? {
              'packages/adapters/src/providers/conformance.test.ts': 19,
              'packages/adapters/src/providers/protocol.test.ts': 8,
              'tests/probe.test.ts': 12,
              'packages/adapters/src/codex/transport.test.ts': 20,
              'packages/adapters/src/codex/profile.test.ts': 5,
              'packages/adapters/src/codex/lifecycle.test.ts': 9,
              'packages/adapters/src/codex/thread.test.ts': 15,
              'tests/codex-process.test.ts': 6,
              'packages/storage/src/providers.test.ts': 41,
              'tests/faults/provider-crash.test.ts': 8,
              'packages/storage/src/workspace.test.ts': 5,
              'apps/controller/src/native-verifier.test.ts': 21,
              'tests/faults/native-verification.test.ts': 4,
              'packages/core/src/native-acceptance.test.ts': 8,
              'apps/controller/src/native-review.test.ts': 12,
              'tests/faults/native-acceptance.test.ts': 3,
              'apps/controller/src/codex-offline.test.ts': 34,
              'packages/supervisor/src/interactive.test.ts': 3,
              'tests/faults/codex-controller.test.ts': 9,
              'packages/adapters/src/providers/native-stream.test.ts': 34,
              'packages/adapters/src/providers/native-lifecycle.test.ts': 34,
              'tests/native-process.test.ts': 2,
              'apps/controller/src/native-offline.test.ts': 97,
              'packages/adapters/src/providers/claude-launch.test.ts': 16,
              'tests/faults/claude-launch.test.ts': 8,
              'tests/faults/native-controller.test.ts': 26,
              'tests/faults/native-session.test.ts': 4,
              'packages/adapters/src/providers/failures.test.ts': 18,
              'apps/controller/src/offline-roster.test.ts': 2,
              'packages/adapters/src/opencode/endpoint.test.ts': 9,
              'apps/controller/src/opencode-http.test.ts': 16,
              'tests/faults/opencode-http.test.ts': 6,
              'apps/controller/src/opencode-live.test.ts': 17,
              'packages/adapters/src/opencode/cli-stream.test.ts': 21,
              'tests/faults/opencode-live.test.ts': 12,
            }
          : {}),
        ...(phase === '04' || phase === '05'
          ? {
              'packages/context/src/packet.test.ts': 21,
              'packages/context/src/retrieval.test.ts': 12,
              'packages/storage/src/memory.test.ts': 12,
              'packages/memory/src/relevance.test.ts': 5,
              'packages/context/src/handoff.test.ts': 10,
              'packages/context/src/inspect.test.ts': 2,
              'packages/context/src/transfer.test.ts': 6,
              'apps/controller/src/handoff-fixture.test.ts': 3,
            }
          : {}),
        ...(phase === '05'
          ? {
              'packages/tools/src/registry.test.ts': 10,
              'packages/tools/src/files.test.ts': 18,
              'packages/tools/src/repository.test.ts': 6,
              'packages/tools/src/process.test.ts': 12,
              'packages/tools/src/controller.test.ts': 5,
              'packages/tools/src/mcp.test.ts': 8,
              'packages/tools/src/browser.test.ts': 8,
              'packages/skills/src/catalog.test.ts': 12,
              'packages/skills/src/hooks.test.ts': 4,
              'packages/skills/src/bundled.test.ts': 13,
              'packages/skills/src/compatibility.test.ts': 4,
              'packages/policy/src/runtimes.test.ts': 9,
              'apps/controller/src/tools-fixture.test.ts': 1,
            }
          : {}),
      };
}
