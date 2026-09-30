import type { ToolApproval, ToolManifest } from '../../contracts/src/tools.ts';

export type ToolDecision =
  | { allowed: true; approvedBy?: string }
  | {
      allowed: false;
      code:
        | 'POLICY_DENIED'
        | 'CAPABILITY_UNSUPPORTED'
        | 'APPROVAL_REQUIRED'
        | 'STALE_APPROVAL';
      reason: string;
    };
/**
 * Effects each profile may request. No tested network or external-write
 * boundary exists, so those classes are unsupported everywhere; unknown
 * profiles fail closed rather than falling back to a weaker one.
 */
const PROFILES: Record<string, readonly string[]> = {
  'read-only': ['read'],
  simulation: ['read'],
  'trusted-local': ['read', 'workspace-write', 'process'],
};
const APPROVAL_EFFECTS = new Set(['process', 'network', 'external-write']);

/**
 * Decide one tool action from host-owned scope only: the task catalog, the
 * permission profile, and approvals recorded for this exact action hash.
 */
export function authorizeTool(request: {
  manifest: ToolManifest;
  allowedTools: readonly string[];
  profile: string;
  actionHash: string;
  approvals: readonly ToolApproval[];
  now: number;
}): ToolDecision {
  const { manifest } = request;
  if (!request.allowedTools.includes(manifest.name))
    return {
      allowed: false,
      code: 'POLICY_DENIED',
      reason: 'Tool is not in this task catalog',
    };
  const effects = Object.hasOwn(PROFILES, request.profile)
    ? PROFILES[request.profile]!
    : undefined;
  if (!effects)
    return {
      allowed: false,
      code: 'CAPABILITY_UNSUPPORTED',
      reason: 'No tested enforcement exists for this permission profile',
    };
  if (manifest.effect === 'network' || manifest.effect === 'external-write')
    return {
      allowed: false,
      code: 'CAPABILITY_UNSUPPORTED',
      reason: 'No tested boundary exists for this effect class',
    };
  if (!effects.includes(manifest.effect))
    return {
      allowed: false,
      code: 'POLICY_DENIED',
      reason: 'The permission profile does not allow this effect',
    };
  if (!APPROVAL_EFFECTS.has(manifest.effect) || manifest.preapproved)
    return { allowed: true };
  const approval = request.approvals.find(
    (entry) => entry.actionHash === request.actionHash,
  );
  if (!approval)
    return {
      allowed: false,
      code: 'APPROVAL_REQUIRED',
      reason: 'This exact action needs approval',
    };
  if (approval.expiresAt <= request.now)
    return {
      allowed: false,
      code: 'STALE_APPROVAL',
      reason: 'The approval for this action expired',
    };
  return { allowed: true, approvedBy: approval.decidedBy };
}
