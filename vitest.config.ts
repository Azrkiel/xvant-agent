import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // Tests that spawn Git or child processes take several seconds on a loaded Windows host.
    testTimeout: 15000,
    // Hosted Windows has slower durable I/O. Serialize suites rather than
    // weakening the journal/death-test deadlines or durability settings.
    maxWorkers: process.platform === 'win32' ? 1 : 2,
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
        'apps/controller/src/opencode-live.ts',
        'apps/controller/src/service.ts',
        'apps/controller/src/http/**/*.ts',
        'scripts/gate-policy.ts',
        'scripts/ci-policy.ts',
        'scripts/browser-path.ts',
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
