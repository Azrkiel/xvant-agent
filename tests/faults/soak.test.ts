import { expect, it, vi } from 'vitest';
import { runSoak, seeded, SCENARIOS } from '../../scripts/soak-run.ts';

// Each iteration creates a repository and several worktrees.
vi.setConfig({ testTimeout: 180000 });

it('is deterministic for a seed', () => {
  const a = seeded(7);
  const b = seeded(7);
  expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  expect(seeded(8)()).not.toBe(seeded(7)());
});

it('runs a handful of fault iterations with no invariant violation', async () => {
  // Seed 1 over 6 iterations draws several different scenarios.
  const report = await runSoak({ seed: 1, maxIterations: 6 });
  expect(report.violations).toEqual([]);
  expect(report.iterations).toBe(6);
  expect(Object.keys(report.scenarioCounts).length).toBeGreaterThan(2);
  for (const name of Object.keys(report.scenarioCounts))
    expect(SCENARIOS).toContain(name);
  expect(report.memory.lastRss).toBeGreaterThan(0);
  expect(Object.values(report.phaseCounts).reduce((a, b) => a + b, 0)).toBe(6);
});
