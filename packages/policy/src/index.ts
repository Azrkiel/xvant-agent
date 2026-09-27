/** Capability claims are implementation facts, never caller-supplied attestations. */
export function executionCapabilities() {
  return Object.freeze({
    platform: process.platform,
    trustedLocalProcess: ['win32', 'linux'].includes(process.platform),
    hostileCodeContainment: false,
    filesystemIsolation: false,
    networkIsolation: false,
    processTreeContainment: false,
  });
}

export function authorizeExecution(request: {
  profile: string;
  userApproved: boolean;
}):
  | { allowed: true; isolation: 'none' | 'simulation-only' }
  | {
      allowed: false;
      code: 'POLICY_DENIED' | 'CAPABILITY_UNSUPPORTED';
      reason: string;
    } {
  if (request.profile === 'simulation')
    return { allowed: true, isolation: 'simulation-only' };
  if (request.profile !== 'trusted-local')
    return {
      allowed: false,
      code: 'CAPABILITY_UNSUPPORTED',
      reason:
        'No tested OS sandbox is registered. Restricted execution is unavailable.',
    };
  if (!request.userApproved)
    return {
      allowed: false,
      code: 'POLICY_DENIED',
      reason: 'Trusted local process execution requires explicit approval.',
    };
  if (!executionCapabilities().trustedLocalProcess)
    return {
      allowed: false,
      code: 'CAPABILITY_UNSUPPORTED',
      reason: 'Process supervision is unavailable on this platform.',
    };
  return { allowed: true, isolation: 'none' };
}
