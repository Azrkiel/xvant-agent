import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('Codex offline stdio process', () => {
  it.each(['success', 'approval', 'interrupt'])(
    'runs %s through real Node pipes with no provider',
    (scenario) => {
      const child = spawnSync(
        process.execPath,
        ['scripts/codex-fixture.mjs', scenario],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      expect(child.status, child.stderr).toBe(0);
      const report = JSON.parse(child.stdout);
      expect(report.classification).toBe('offline');
      expect(report.liveProvidersTested).toEqual([]);
      expect(report.state).toBe('result_pending');
      expect(report.persistedBeforeWrite).toBe(true);
      expect(report.durableState).toBe('result_pending');
      expect(report.taskState).toBe('needs_attention');
      expect(report.persistedInbound).toBeGreaterThan(2);
      if (scenario === 'approval') expect(report.denials).toBe(1);
      if (scenario === 'interrupt') expect(report.outcome).toBe('cancelled');
    },
    15000,
  );
  it.each(['disconnect', 'malformed', 'timeout'])(
    'retains uncertainty after %s and does not resend',
    (scenario) => {
      const child = spawnSync(
        process.execPath,
        ['scripts/codex-fixture.mjs', scenario],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      expect(child.status, child.stderr).toBe(0);
      const report = JSON.parse(child.stdout);
      expect(report.state).toBe('needs_attention');
      expect(report.turnRequests).toBe(1);
      expect(report.outcome).toBe('unknown');
      expect(report.durableState).toBe('unknown');
      expect(report.taskState).toBe('needs_attention');
    },
    15000,
  );
});
