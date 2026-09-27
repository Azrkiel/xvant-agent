import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    testTimeout: 5000,
    coverage: {
      provider: 'v8',
      include: [
        'packages/**/src/**/*.ts',
        'apps/controller/src/controller.ts',
        'scripts/gate-policy.ts',
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
