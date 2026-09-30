import { z } from 'zod';
import { idSchema } from './index.ts';
import type { ProviderKind } from './providers.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * Live routes qualified on this host. A route is a runtime version, the
 * adapter that drives it, its transport and the shape of its session IDs.
 * Changing a version here requires a new live probe, not an edit alone.
 */
export const LIVE_ROUTES = {
  codex: {
    runtimeVersion: '0.158.0-alpha.2.1',
    adapterVersion: 'codex-app-server-v1',
    transport: 'app-server',
    session: uuid,
  },
  claude: {
    runtimeVersion: '2.1.285',
    adapterVersion: 'claude-headless-v1',
    transport: 'headless',
    session: uuid,
  },
  opencode: {
    runtimeVersion: '2.0.19',
    adapterVersion: 'opencode-cli-v2',
    transport: 'cli',
    session: /^ses_[A-Za-z0-9]+$/,
  },
} as const satisfies Record<
  ProviderKind,
  {
    runtimeVersion: string;
    adapterVersion: string;
    transport: string;
    session: RegExp;
  }
>;
/** OpenCode models that bill nothing. Anything else could route to a paid provider. */
export const FREE_OPENCODE_MODELS = ['opencode/big-pickle'] as const;

export const liveApprovalSchema = z.strictObject({
  actorId: idSchema,
  /** `default` lets the runtime pick; otherwise a bounded model identifier. */
  model: z.string().regex(/^[A-Za-z0-9._/:-]{1,96}$/),
  transport: z.enum(['app-server', 'headless', 'cli']),
  userApprovedTrustedLocal: z.literal(true),
  /** `text` answers without editing; `workspace-write` edits its own worktree. */
  profile: z.enum(['text', 'workspace-write']).optional(),
  /** Native edit/shell tools bypass XVANT approvals and receipts. */
  acknowledgedNativeBypass: z.literal(true).optional(),
});
export type LiveApproval = z.infer<typeof liveApprovalSchema>;

/** Why this live dispatch is not an admitted route, or undefined when it is. */
export function liveRouteIssue(
  approvalInput: unknown,
  worker: {
    runtimeKind: string;
    runtimeVersion: string;
    adapterVersion: string;
    nativeSessionId: string;
  },
  connectionId: string,
): string | undefined {
  const parsed = liveApprovalSchema.safeParse(approvalInput);
  if (!parsed.success) return 'LIVE_APPROVAL_REQUIRED';
  const approval = parsed.data;
  if (!Object.hasOwn(LIVE_ROUTES, worker.runtimeKind))
    return 'VERSION_UNSUPPORTED';
  const route = LIVE_ROUTES[worker.runtimeKind as ProviderKind];
  if (
    worker.runtimeVersion !== route.runtimeVersion ||
    worker.adapterVersion !== route.adapterVersion ||
    approval.transport !== route.transport
  )
    return 'VERSION_UNSUPPORTED';
  if (
    worker.nativeSessionId !== 'pending:' + connectionId &&
    !route.session.test(worker.nativeSessionId)
  )
    return 'SESSION_MISMATCH';
  if (
    worker.runtimeKind === 'opencode' &&
    !(FREE_OPENCODE_MODELS as readonly string[]).includes(approval.model)
  )
    return 'BILLING_UNVERIFIED';
  if (
    approval.profile === 'workspace-write' &&
    approval.acknowledgedNativeBypass !== true
  )
    return 'POLICY_DENIED';
  return undefined;
}
