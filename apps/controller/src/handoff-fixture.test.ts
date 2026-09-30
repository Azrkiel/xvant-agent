import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffFailures, runHandoffFixture } from './handoff-fixture.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-handoff-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('offline handoff fixture', () => {
  it('lets a second worker finish the task from the packet alone', async () => {
    const report = await runHandoffFixture(root);
    expect(handoffFailures(report)).toEqual([]);
    expect(report).toMatchObject({
      classification: 'offline',
      liveProvidersTested: [],
      runtimeKind: 'simulated',
      from: 'codex-1',
      to: 'claude-1',
      packetVerified: true,
      sentinelsAbsent: true,
      recipient: { exitCode: 0, completed: true },
      check: 'passed',
    });
    expect(report.requiredFacts.present).toBe(report.requiredFacts.expected);
    expect(report.memory.included).toEqual(['architecture#retry-decision']);
    expect(report.memory.excluded).toEqual([
      { id: 'draft-idea', reason: 'unaccepted' },
      { id: 'foreign-note', reason: 'cross_project' },
      { id: 'old-layout', reason: 'stale' },
    ]);
    expect(report.retrievalOmitted).toEqual([
      { path: '.env', reason: 'secret_path' },
      { path: 'config/deploy.ts', reason: 'secret_content' },
    ]);
    expect(report.inspectionEntries).toBeGreaterThan(5);
  }, 30000);
  it('fails when the handoff omits the continuation value', async () => {
    const report = await runHandoffFixture(root, { scenario: 'missing-token' });
    expect(report.recipient.completed).toBe(false);
    expect(report.check).toBe('failed');
    expect(handoffFailures(report)).toContain('recipient did not complete');
  }, 30000);
  it('makes the recipient refuse a tampered packet', async () => {
    const report = await runHandoffFixture(root, { scenario: 'tampered' });
    expect(report.recipient.exitCode).not.toBe(0);
    expect(report.recipient.completed).toBe(false);
    expect(report.check).toBe('failed');
  }, 30000);
});
