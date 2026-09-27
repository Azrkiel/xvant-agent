import { describe, expect, it } from 'vitest';
import { normalizeFixture, fixtureFor, runOfflineRoster } from './protocol.ts';

describe('provider protocol fixture translation', () => {
  it.each(['codex', 'claude', 'opencode'] as const)(
    '%s correlates a bounded result and rejects cross-session output',
    (kind) => {
      const fixture = fixtureFor(kind, 'session/1', 'run/1');
      expect(normalizeFixture(kind, fixture, 'session/1', 'run/1')).toEqual({
        kind: 'completed',
      });
      expect(() =>
        normalizeFixture(kind, fixture, 'session/2', 'run/1'),
      ).toThrow('INVALID_EVENT');
      expect(() =>
        normalizeFixture(kind, fixture, 'session/1', 'run/2'),
      ).toThrow('INVALID_EVENT');
      expect(() => normalizeFixture(kind, {}, 'session/1', 'run/1')).toThrow();
    },
  );
  it('Codex failure and interruption never translate to success', () => {
    for (const [status, expected] of [
      ['failed', 'failed'],
      ['interrupted', 'cancelled'],
    ] as const)
      expect(
        normalizeFixture(
          'codex',
          {
            method: 'turn/completed',
            params: { threadId: 's', turn: { id: 'r', status } },
          },
          's',
          'r',
        ).kind,
      ).toBe(expected);
  });
  it('Claude error result never translates to success', () => {
    expect(
      normalizeFixture(
        'claude',
        {
          invocationId: 'r',
          message: {
            type: 'result',
            subtype: 'error_during_execution',
            session_id: 's',
            is_error: true,
          },
        },
        's',
        'r',
      ),
    ).toEqual({ kind: 'failed', code: 'WORKER_FAILED' });
  });
  it('OpenCode idle alone does not prove completion', () => {
    expect(() =>
      normalizeFixture(
        'opencode',
        { type: 'session.idle', properties: { sessionID: 's' } },
        's',
        'r',
      ),
    ).toThrow();
  });
  it('OpenCode incomplete assistant response does not prove completion', () => {
    expect(() =>
      normalizeFixture(
        'opencode',
        {
          type: 'message.updated',
          properties: {
            info: {
              id: 'r',
              sessionID: 's',
              role: 'assistant',
              time: { created: 1 },
            },
          },
        },
        's',
        'r',
      ),
    ).toThrow();
  });
  it('replays ten separately correlated fixture results with live disabled', () => {
    const report = runOfflineRoster();
    expect(report.classification).toBe('offline');
    expect(report.liveProvidersTested).toEqual([]);
    expect(report.results).toHaveLength(10);
    expect(new Set(report.results.map((r) => r.workerId)).size).toBe(10);
    expect(
      report.results.every(
        (r) => r.outcome === 'completed' && r.liveEnabled === false,
      ),
    ).toBe(true);
  });
});
