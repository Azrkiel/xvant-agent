import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    testTimeout: 5000,
    // Bound concurrent process-heavy suites; Windows startup otherwise exhausts deadlines.
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: [
        'packages/**/src/**/*.ts',
        'apps/controller/src/controller.ts',
        'apps/controller/src/durable.ts',
        'apps/controller/src/native-verifier.ts',
        'apps/controller/src/native-review.ts',
        'apps/controller/src/codex-offline.ts',
        'apps/controller/src/native-offline.ts',
        'apps/controller/src/service.ts',
        'apps/controller/src/http/**/*.ts',
        'scripts/gate-policy.ts',
        'scripts/probe-policy.ts',
      ],
      exclude: ['**/*.test.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        'packages/core/src/task.ts': { branches: 90 },
        'packages/core/src/graph.ts': { branches: 90 },
      },
    },
  },
});
