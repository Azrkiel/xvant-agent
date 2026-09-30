import { describe, expect, it } from 'vitest';
import { LIVE_ROUTES, liveRouteIssue } from './live.ts';

const uuid = '01a0f355-2260-71d2-bd32-9fd8718d9045';
const approval = (over: Record<string, unknown> = {}) => ({
  actorId: 'operator',
  model: 'default',
  transport: 'app-server',
  userApprovedTrustedLocal: true,
  ...over,
});
const worker = (over: Record<string, unknown> = {}) => ({
  runtimeKind: 'codex',
  runtimeVersion: LIVE_ROUTES.codex.runtimeVersion,
  adapterVersion: LIVE_ROUTES.codex.adapterVersion,
  nativeSessionId: uuid,
  ...over,
});

describe('live routes', () => {
  it('admits each qualified route', () => {
    expect(liveRouteIssue(approval(), worker(), 'c1')).toBeUndefined();
    expect(
      liveRouteIssue(
        approval({ transport: 'headless', model: 'claude-sonnet-5-5' }),
        worker({
          runtimeKind: 'claude',
          runtimeVersion: LIVE_ROUTES.claude.runtimeVersion,
          adapterVersion: LIVE_ROUTES.claude.adapterVersion,
        }),
        'c1',
      ),
    ).toBeUndefined();
    expect(
      liveRouteIssue(
        approval({ transport: 'cli', model: 'opencode/big-pickle' }),
        worker({
          runtimeKind: 'opencode',
          runtimeVersion: '2.0.19',
          adapterVersion: 'opencode-cli-v2',
          nativeSessionId: 'ses_abc',
        }),
        'c1',
      ),
    ).toBeUndefined();
  });
  it('accepts a provisional session for creation', () =>
    expect(
      liveRouteIssue(
        approval(),
        worker({ nativeSessionId: 'pending:c1' }),
        'c1',
      ),
    ).toBeUndefined());
  it.each([
    ['wrong transport', approval({ transport: 'cli' }), worker()],
    ['unpinned version', approval(), worker({ runtimeVersion: '0.1.0' })],
    [
      'foreign pending id',
      approval(),
      worker({ nativeSessionId: 'pending:c2' }),
    ],
    ['malformed session', approval(), worker({ nativeSessionId: 'latest' })],
    [
      'paid opencode model',
      approval({ transport: 'cli', model: 'anthropic/claude' }),
      worker({
        runtimeKind: 'opencode',
        runtimeVersion: '2.0.19',
        adapterVersion: 'opencode-cli-v2',
        nativeSessionId: 'ses_abc',
      }),
    ],
    [
      'write without acknowledgement',
      approval({ profile: 'workspace-write' }),
      worker(),
    ],
  ])('rejects %s', (_name, a, w) =>
    expect(liveRouteIssue(a, w, 'c1')).toBeTypeOf('string'),
  );
  it('admits workspace writes only with acknowledged native bypass', () =>
    expect(
      liveRouteIssue(
        approval({
          profile: 'workspace-write',
          acknowledgedNativeBypass: true,
        }),
        worker(),
        'c1',
      ),
    ).toBeUndefined());
});
