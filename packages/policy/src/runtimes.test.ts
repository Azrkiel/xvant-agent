import { describe, expect, it } from 'vitest';
import { RUNTIME_TOOL_PROFILES, admitRuntimeProfile } from './runtimes.ts';

describe('runtime native-tool admission', () => {
  it.each(['codex', 'claude', 'opencode'])(
    'blocks restricted profiles on %s because native tools cannot be restricted with tested evidence',
    (runtime) => {
      for (const profile of ['read-only', 'simulation']) {
        const decision = admitRuntimeProfile({
          runtime,
          profile,
          acknowledgedNativeBypass: true,
        });
        expect(decision).toMatchObject({
          allowed: false,
          code: 'CAPABILITY_UNSUPPORTED',
        });
      }
    },
  );
  it.each(['codex', 'claude', 'opencode'])(
    'requires acknowledging native-tool bypass for trusted-local on %s',
    (runtime) => {
      expect(
        admitRuntimeProfile({ runtime, profile: 'trusted-local' }),
      ).toMatchObject({ allowed: false, code: 'POLICY_DENIED' });
      const admitted = admitRuntimeProfile({
        runtime,
        profile: 'trusted-local',
        acknowledgedNativeBypass: true,
      });
      expect(admitted.allowed).toBe(true);
      expect(admitted.risks.join('\n')).toMatch(
        /shell.*bypasses XVANT approvals/,
      );
    },
  );
  it('admits XVANT-owned runtimes without native tools under any known profile', () => {
    for (const runtime of ['native-local', 'simulated'])
      for (const profile of ['read-only', 'simulation', 'trusted-local'])
        expect(admitRuntimeProfile({ runtime, profile })).toEqual({
          allowed: true,
          risks: [],
        });
  });
  it('fails closed on unknown runtimes and profiles', () => {
    expect(
      admitRuntimeProfile({ runtime: 'gpt', profile: 'read-only' }),
    ).toMatchObject({
      allowed: false,
      code: 'CAPABILITY_UNSUPPORTED',
    });
    expect(
      admitRuntimeProfile({ runtime: 'native-local', profile: 'sandboxed' }),
    ).toMatchObject({ allowed: false, code: 'CAPABILITY_UNSUPPORTED' });
  });
  it('claims no live-tested restriction for any external runtime', () => {
    for (const profile of RUNTIME_TOOL_PROFILES)
      for (const tool of profile.nativeTools)
        expect(tool.restriction).not.toBe('tested-live');
  });
});
