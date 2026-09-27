import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateNative, CODEX_VERSION, pinInfo } from './profile.ts';

describe('installed Codex schema pin', () => {
  it('preserves schema property names that resemble metadata keywords', () => {
    const schema = JSON.parse(
      readFileSync(new URL('./schema.json', import.meta.url), 'utf8'),
    );
    expect(
      schema.definitions.AsyncUserInputQuestion.properties.title.type,
    ).toBe('string');
  });
  it('records the exact runtime and generated schema hashes', () => {
    expect(CODEX_VERSION).toBe('0.158.0-alpha.2.1');
    expect(pinInfo().sources.length).toBeGreaterThan(8);
    expect(
      pinInfo().sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)),
    ).toBe(true);
  });
  it('validates required turn fields from the generated schema', () => {
    expect(() =>
      validateNative('TurnStartResponse', {
        turn: { id: 'turn-1', status: 'inProgress', items: [] },
      }),
    ).not.toThrow();
    expect(() =>
      validateNative('TurnStartResponse', {
        turn: { id: 'turn-1', status: 'inProgress' },
      }),
    ).toThrow('INVALID_EVENT');
    expect(() =>
      validateNative('TurnCompletedNotification', {
        threadId: 't',
        turn: { id: 'r', status: 'invented', items: [] },
      }),
    ).toThrow('INVALID_EVENT');
  });
  it('validates permission denial and rejects invented decisions', () => {
    expect(() =>
      validateNative('CommandExecutionRequestApprovalResponse', {
        decision: 'decline',
      }),
    ).not.toThrow();
    expect(() =>
      validateNative('FileChangeRequestApprovalResponse', {
        decision: 'decline',
      }),
    ).not.toThrow();
    expect(() =>
      validateNative('CommandExecutionRequestApprovalResponse', {
        decision: 'allowEverything',
      }),
    ).toThrow('INVALID_EVENT');
  });
  it('fails closed for unknown schema names', () => {
    expect(() => validateNative('Unknown', {})).toThrow('VERSION_UNSUPPORTED');
  });
});
