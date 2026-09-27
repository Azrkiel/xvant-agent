import { describe, expect, it } from 'vitest';
import { executionCapabilities, authorizeExecution } from './index.ts';

describe('execution boundary policy', () => {
  it('reports trusted local execution without claiming sandbox enforcement', () => {
    expect(executionCapabilities()).toMatchObject({
      hostileCodeContainment: false,
      filesystemIsolation: false,
      networkIsolation: false,
    });
    expect(
      authorizeExecution({ profile: 'trusted-local', userApproved: true }),
    ).toEqual({ allowed: true, isolation: 'none' });
  });
  it('fails closed for sandbox profiles, missing approval and unknown profiles', () => {
    for (const request of [
      { profile: 'sandboxed', userApproved: true },
      { profile: 'trusted-local', userApproved: false },
      { profile: 'invented', userApproved: true },
    ]) {
      expect(authorizeExecution(request).allowed).toBe(false);
    }
    expect(
      authorizeExecution({ profile: 'simulation', userApproved: false }),
    ).toEqual({ allowed: true, isolation: 'simulation-only' });
  });
});
