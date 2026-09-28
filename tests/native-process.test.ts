import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
it.each(['claude', 'opencode'])(
  '%s native offline process conformance',
  (kind) => {
    for (const scenario of [
      'success',
      'permission',
      'wrong-session',
      'malformed',
      'partial',
      'error',
      'timeout',
      'cancel',
    ]) {
      const child = spawnSync(
        process.execPath,
        ['scripts/native-fixture.mjs', kind, scenario],
        { encoding: 'utf8', timeout: 12000, windowsHide: true },
      );
      expect(child.status, child.stderr + child.stdout).toBe(0);
      const report = JSON.parse(child.stdout);
      expect(report).toMatchObject({
        classification: 'offline',
        liveProvidersTested: [],
        activeCount: 0,
      });
      expect(report.outcome).toBe(
        ['success', 'permission'].includes(scenario)
          ? 'completed'
          : kind === 'claude' && scenario === 'error'
            ? 'failed'
            : 'unknown',
      );
      if (scenario === 'permission') expect(report.denials).toBe(1);
    }
  },
  45000,
);
