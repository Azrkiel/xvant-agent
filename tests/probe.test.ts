import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { probeInventory } from '../scripts/probe-policy.ts';
import { phaseSuites } from '../scripts/gate-policy.ts';

describe('provider probe boundary', () => {
  it('requires all new suites in the offline Phase 3 gate', () => {
    const suites = phaseSuites('03');
    for (const file of [
      'packages/adapters/src/codex/transport.test.ts',
      'packages/adapters/src/codex/profile.test.ts',
      'packages/adapters/src/codex/lifecycle.test.ts',
      'tests/codex-process.test.ts',
      'packages/adapters/src/providers/conformance.test.ts',
      'packages/adapters/src/providers/protocol.test.ts',
      'tests/probe.test.ts',
    ])
      expect(suites[file]).toBeGreaterThan(0);
    expect(suites['tests/faults/crash.test.ts']).toBeGreaterThan(0);
    expect(() => phaseSuites('06')).toThrow();
  });
  it('runs only bounded version commands and never treats inventory as live support', () => {
    const calls: string[] = [];
    const report = probeInventory(['codex', 'claude', 'opencode'], (kind) => {
      calls.push(kind);
      return { status: 0, stdout: `${kind} 1.2.3\n`, stderr: '' };
    });
    expect(calls).toEqual(['codex', 'claude', 'opencode']);
    expect(report.exitCode).toBe(0);
    expect(
      report.providers.every(
        (p) =>
          p.liveEnabled === false &&
          p.auth === 'untested' &&
          p.billing === 'unknown',
      ),
    ).toBe(true);
  });
  it('reports missing executables as unavailable, not passed', () => {
    expect(
      probeInventory(['opencode'], () => ({
        status: null,
        errorCode: 'ENOENT',
        stdout: '',
        stderr: '',
      })).exitCode,
    ).toBe(2);
  });
  it.each([
    { status: null, errorCode: 'ETIMEDOUT', stdout: '', stderr: '' },
    { status: 1, stdout: '', stderr: 'secret value' },
    { status: 0, stdout: 'secret value', stderr: '' },
  ])('fails bad inventory without echoing raw diagnostics', (result) => {
    const report = probeInventory(['codex'], () => result);
    expect(report.exitCode).toBe(1);
    expect(JSON.stringify(report)).not.toContain('secret value');
  });
  it('rejects duplicate or unsupported providers before invoking anything', () => {
    expect(() =>
      probeInventory(['codex', 'codex'], () => {
        throw new Error('called');
      }),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      probeInventory(['unknown'], () => {
        throw new Error('called');
      }),
    ).toThrow('INVALID_INPUT');
  });
  it.each(
    [
      [],
      ['--live', '--read-only', '--runtime', 'all'],
      ['--offline', '--runtime', 'all', '--live'],
      ['--inventory-only', '--runtime', 'unknown'],
    ].map((args) => ({ args })),
  )('CLI rejects unsafe or malformed flags: $args', ({ args }) => {
    const child = spawnSync(process.execPath, ['scripts/probe.mjs', ...args], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    expect(child.status).toBe(2);
    expect(child.stdout).not.toContain('"status":"passed"');
  });
  it('CLI offline mode runs in real Node with no credentials or provider executables', () => {
    const child = spawnSync(
      process.execPath,
      ['scripts/probe.mjs', '--offline', '--runtime', 'all'],
      {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        env: { PATH: '', SystemRoot: process.env.SystemRoot ?? '' },
      },
    );
    expect(child.status).toBe(0);
    const report = JSON.parse(child.stdout);
    expect(report.results).toHaveLength(10);
    expect(report.liveProvidersTested).toEqual([]);
  });
});
