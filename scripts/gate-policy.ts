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
