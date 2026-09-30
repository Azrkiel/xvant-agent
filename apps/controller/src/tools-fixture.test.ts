import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runToolsFixture, toolsFailures } from './tools-fixture.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-tools-fixture-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('holds every G05 boundary against a hostile worker behind the MCP bridge', async () => {
  const report = await runToolsFixture(root);
  expect(toolsFailures(report)).toEqual([]);
  expect(Object.keys(report.checks).sort()).toEqual([
    'catalogUnchanged',
    'duplicateHooksMerged',
    'everyCallReceipted',
    'injectionDelivered',
    'modifiedSkillRejected',
    'nativeRuntimeAdmitted',
    'outsideUntouched',
    'pathEscapesDenied',
    'pinnedSkillsStable',
    'restrictedProfilesBlocked',
    'skillCannotWidenCatalog',
    'stalePatchRejected',
    'uncatalogedToolDenied',
    'verifiedClaimRefused',
  ]);
  expect(report.receipts.some((r) => r.code === 'POLICY_DENIED')).toBe(true);
}, 60_000);
