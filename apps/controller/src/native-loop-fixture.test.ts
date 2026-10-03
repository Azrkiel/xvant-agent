import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeFailures, runNativeFixture } from './native-loop-fixture.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-native-loop-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));

it('holds every G08 boundary against a hostile local model and runs every skill fixture', async () => {
  const report = await runNativeFixture(root);
  expect(nativeFailures(report)).toEqual([]);
  expect(Object.keys(report.checks).sort()).toEqual([
    'approvalNotSelfGranted',
    'cooperativeAccepted',
    'hostileNotAccepted',
    'invalidNeverExecuted',
    'noCredentialsSent',
    'nonLoopbackRefused',
    'pendingCallNotRepeated',
    'probeRejectsWrongToolCall',
    'receiptsSurviveRestart',
    'skillFixturesPassed',
    'stepCapRespected',
  ]);
  expect(report.hostile).toMatchObject({
    status: 'failed',
    failure: 'WORKER_FAILED:step_limit',
    modelCalls: 8,
  });
  expect(Object.keys(report.skills)).toHaveLength(10);
}, 180_000);

it('reports a failed check by name', () => {
  expect(
    nativeFailures({
      classification: 'offline',
      liveProvidersTested: [],
      runtimeKind: 'native-local',
      model: 'stub',
      checks: { a: true, b: false },
      hostile: { status: 'failed', modelCalls: 0 },
      receipts: [],
      skills: {},
    }),
  ).toEqual(['b']);
});
