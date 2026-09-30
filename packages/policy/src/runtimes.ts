import { profileAllows } from './tools.ts';

type Evidence = 'tested-live' | 'offline-only' | 'untested';
export interface RuntimeToolProfile {
  runtime: 'codex' | 'claude' | 'opencode' | 'native-local' | 'simulated';
  /** Tools the runtime runs itself, outside XVANT's registry, receipts and approvals. */
  nativeTools: {
    kind: 'shell' | 'file_write' | 'network';
    mechanism: string;
    restriction: Evidence;
  }[];
  /** Whether XVANT's own tools reach the runtime (through the MCP bridge). */
  mcpClient: Evidence | 'not-needed';
}
/**
 * What is known about each runtime's native tools. Only `tested-live`
 * evidence can enforce a restricted profile; offline fixtures show the
 * mechanism is wired, not that the vendor runtime honors it.
 */
export const RUNTIME_TOOL_PROFILES: readonly RuntimeToolProfile[] = [
  {
    runtime: 'codex',
    nativeTools: [
      {
        kind: 'shell',
        mechanism: 'read-only sandbox and untrusted approval policy',
        restriction: 'offline-only',
      },
      {
        kind: 'file_write',
        mechanism: 'apply_patch under the read-only sandbox',
        restriction: 'offline-only',
      },
      {
        kind: 'network',
        mechanism: 'sandbox network access setting',
        restriction: 'untested',
      },
    ],
    // Live G05 (2026-09-30): a real client called file.read through the bridge.
    mcpClient: 'tested-live',
  },
  {
    runtime: 'claude',
    nativeTools: [
      {
        kind: 'shell',
        mechanism: 'Bash through SDK disallowed tools and permission callback',
        restriction: 'offline-only',
      },
      {
        kind: 'file_write',
        mechanism:
          'Edit and Write through SDK disallowed tools and permission callback',
        restriction: 'offline-only',
      },
      {
        kind: 'network',
        mechanism: 'WebFetch and WebSearch through SDK disallowed tools',
        restriction: 'untested',
      },
    ],
    // Live G05 (2026-09-30): a real client called file.read through the bridge.
    mcpClient: 'tested-live',
  },
  {
    runtime: 'opencode',
    nativeTools: [
      {
        kind: 'shell',
        mechanism: 'bash through deny-all agent permission rules',
        restriction: 'offline-only',
      },
      {
        kind: 'file_write',
        mechanism: 'edit and write through deny-all agent permission rules',
        restriction: 'offline-only',
      },
      {
        kind: 'network',
        mechanism: 'webfetch through agent permission rules',
        restriction: 'untested',
      },
    ],
    // Live G05 (2026-09-30): a real client called file.read through the bridge.
    mcpClient: 'tested-live',
  },
  { runtime: 'native-local', nativeTools: [], mcpClient: 'not-needed' },
  { runtime: 'simulated', nativeTools: [], mcpClient: 'not-needed' },
];
const EFFECT = {
  shell: 'process',
  file_write: 'workspace-write',
  network: 'network',
} as const;
/** Profiles in which the user may knowingly accept native-tool bypass. */
const ACKNOWLEDGEABLE = new Set(['trusted-local']);

export type RuntimeAdmission =
  | { allowed: true; risks: string[] }
  | {
      allowed: false;
      code: 'CAPABILITY_UNSUPPORTED' | 'POLICY_DENIED';
      reason: string;
      risks: string[];
    };

/**
 * Can this runtime run under this permission profile? Restricted profiles
 * fail closed when a native tool they forbid cannot be restricted with live
 * evidence. Trusted-local admits them only after the user acknowledges that
 * native tools bypass XVANT approvals and receipts.
 */
export function admitRuntimeProfile(request: {
  runtime: string;
  profile: string;
  acknowledgedNativeBypass?: boolean;
}): RuntimeAdmission {
  const entry = RUNTIME_TOOL_PROFILES.find(
    (item) => item.runtime === request.runtime,
  );
  if (!entry || profileAllows(request.profile, 'read') === 'unsupported')
    return {
      allowed: false,
      code: 'CAPABILITY_UNSUPPORTED',
      reason: 'Unknown runtime or permission profile',
      risks: [],
    };
  const unrestricted = entry.nativeTools.filter(
    (tool) => tool.restriction !== 'tested-live',
  );
  const risks = unrestricted.map(
    (tool) =>
      `Native ${tool.kind} tool bypasses XVANT approvals and receipts (restriction evidence: ${tool.restriction}; ${tool.mechanism})`,
  );
  if (!ACKNOWLEDGEABLE.has(request.profile)) {
    const violated = unrestricted.filter(
      (tool) => profileAllows(request.profile, EFFECT[tool.kind]) !== 'allowed',
    );
    if (violated.length)
      return {
        allowed: false,
        code: 'CAPABILITY_UNSUPPORTED',
        reason:
          'Cannot enforce this profile: native ' +
          violated.map((tool) => tool.kind).join(', ') +
          ' tools have no live-tested restriction',
        risks,
      };
    return { allowed: true, risks };
  }
  if (unrestricted.length && !request.acknowledgedNativeBypass)
    return {
      allowed: false,
      code: 'POLICY_DENIED',
      reason: 'Native tools bypass XVANT; the user must acknowledge this',
      risks,
    };
  return { allowed: true, risks };
}
