import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromotionLedger } from './ledger.ts';

const h = (c: string) => c.repeat(64);
const pass = {
  promote: true,
  benefits: ['lower median elapsed time'],
  blockers: [],
};
let dir: string;
let ledger: PromotionLedger;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xvant-ledger-'));
  ledger = new PromotionLedger(join(dir, 'ledger.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('promotes with a passing verdict and keeps the version it replaced', () => {
  expect(ledger.current()).toBeNull();
  ledger.initialize('v1', h('a'));
  ledger.promote({ version: 'v2', contentHash: h('b') }, pass, {
    reportHash: h('c'),
    baseline: 'v1',
  });
  expect(ledger.current()).toMatchObject({
    version: 'v2',
    evidence: { baseline: 'v1', benefits: ['lower median elapsed time'] },
  });
  expect(ledger.history().map((e) => e.version)).toEqual(['v1']);
  expect(readdirSync(dir)).toEqual(['ledger.json']);
});

it('refuses a blocked verdict and leaves the default unchanged', () => {
  ledger.initialize('v1', h('a'));
  for (const verdict of [
    { promote: false, benefits: [], blockers: ['no measured benefit'] },
    { promote: true, benefits: [], blockers: ['campaign is incomplete'] },
  ])
    expect(() =>
      ledger.promote({ version: 'v2', contentHash: h('b') }, verdict, {
        reportHash: h('c'),
        baseline: 'v1',
      }),
    ).toThrow('PROMOTION_BLOCKED');
  expect(ledger.current()!.version).toBe('v1');
  expect(ledger.history()).toEqual([]);
});

it('refuses evidence measured against a version that is not the default', () => {
  ledger.initialize('v1', h('a'));
  expect(() =>
    ledger.promote({ version: 'v3', contentHash: h('b') }, pass, {
      reportHash: h('c'),
      baseline: 'v0',
    }),
  ).toThrow('BASELINE_IS_NOT_CURRENT');
});

it('rolls back to the previous known-good version, one step at a time', () => {
  expect(() => ledger.rollback()).toThrow('NO_PREVIOUS_VERSION');
  ledger.initialize('v1', h('a'));
  expect(() => ledger.initialize('v1', h('a'))).toThrow('LEDGER_EXISTS');
  expect(() => ledger.rollback()).toThrow('NO_PREVIOUS_VERSION');
  ledger.promote({ version: 'v2', contentHash: h('b') }, pass, {
    reportHash: h('c'),
    baseline: 'v1',
  });
  ledger.promote({ version: 'v3', contentHash: h('d') }, pass, {
    reportHash: h('e'),
    baseline: 'v2',
  });
  expect(ledger.rollback().version).toBe('v2');
  expect(ledger.rollback()).toMatchObject({
    version: 'v1',
    contentHash: h('a'),
  });
  expect(ledger.current()!.version).toBe('v1');
  expect(() => ledger.rollback()).toThrow('NO_PREVIOUS_VERSION');
});
