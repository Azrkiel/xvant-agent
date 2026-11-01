import { describe, expect, it } from 'vitest';
import {
  evaluateRelease,
  type ReceiptFacts,
} from '../scripts/release-policy.ts';

const NOW = 'tree-now';
const ok = (sourceHash: string | null = NOW): ReceiptFacts => ({
  status: 'passed',
  sourceHash,
  bundle: 'intact',
});
const complete = (): Record<string, ReceiptFacts> => ({
  G00: ok(null),
  G08: ok(),
  G09: ok(),
  G10: ok(),
  'G03-live-roster': ok('older'),
  'G04-live-handoff': ok('older'),
  'G05-live-mcp': ok('older'),
  'G06-live-parallel-feature': ok('older'),
  'G08-live-native': ok('older'),
  'G07-live-ui': ok('older'),
  'P10-clean-install': ok('older'),
  'P10-soak': ok('older'),
  'P10-package': ok('older'),
  'benchmark-v1': {
    ...ok(),
    complete: true,
    suiteShapeProblems: [],
    runtimes: ['claude', 'xvant-orchestrated'],
  },
});
const check = (receipts: Record<string, ReceiptFacts | undefined>) =>
  evaluateRelease('local-v1', { receipts, currentSourceHash: NOW });
const unmet = (receipts: Record<string, ReceiptFacts | undefined>) =>
  Object.fromEntries(
    check(receipts)
      .requirements.filter((r) => r.state === 'unmet')
      .map((r) => [r.id, r.detail]),
  );

describe('release policy', () => {
  it('is ready only when every requirement has passing evidence', () => {
    const result = check(complete());
    expect(result.ready).toBe(true);
    expect(result.requirements.every((r) => r.state === 'met')).toBe(true);
    expect(
      result.requirements.find((r) => r.id === 'G03 offline')!.detail,
    ).toBe('covered by G10');
  });
  it('is not ready with no evidence at all', () => {
    const result = check({});
    expect(result.ready).toBe(false);
    expect(result.requirements.every((r) => r.state === 'unmet')).toBe(true);
  });
  it.each([
    ['failed', { status: 'failed' }, 'receipt is failed'],
    ['missing bundle', { bundle: 'missing' }, 'evidence bundle is missing'],
    ['tampered bundle', { bundle: 'tampered' }, 'evidence bundle is tampered'],
  ] as const)('rejects a %s live receipt', (_name, change, detail) => {
    const receipts = complete();
    receipts['G08-live-native'] = { ...ok('older'), ...change };
    expect(unmet(receipts)).toEqual({ 'G08-live-native': detail });
  });
  it('rejects an offline gate that ran on a different source tree', () => {
    const receipts = complete();
    for (const id of ['G08', 'G09', 'G10']) receipts[id] = ok('older');
    const problems = unmet(receipts);
    expect(Object.keys(problems)).toEqual(
      ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map(
        (n) => 'G' + n + ' offline',
      ),
    );
    expect(problems['G10 offline']).toMatch(/different source tree/);
    expect(problems['G01 offline']).toBe('no receipt');
  });
  it('lets the latest fresh gate cover the earlier ones, and only those', () => {
    const receipts = complete();
    expect(unmet(receipts)).toEqual({});
    receipts.G10 = { ...ok(), status: 'failed' };
    delete receipts.G09;
    receipts.G08 = { ...ok(), status: 'failed' };
    receipts.G06 = ok();
    expect(unmet(receipts)).toEqual({
      'G07 offline': 'no receipt',
      'G08 offline': 'receipt is failed',
      'G09 offline': 'no receipt',
      'G10 offline': 'receipt is failed',
    });
  });
  it('rejects an incomplete or wrongly shaped benchmark', () => {
    const receipts = complete();
    receipts['benchmark-v1'] = { ...ok(), complete: false };
    expect(unmet(receipts)).toEqual({
      'benchmark-v1': 'campaign is incomplete',
    });
    receipts['benchmark-v1'] = {
      ...ok(),
      complete: true,
      suiteShapeProblems: ['needs 24 tasks, has 10'],
    };
    expect(unmet(receipts)['benchmark-v1']).toMatch(/needs 24 tasks/);
    const full = { ...ok(), complete: true, suiteShapeProblems: [] };
    receipts['benchmark-v1'] = { ...full, runtimes: ['claude'] };
    expect(unmet(receipts)['benchmark-v1']).toBe(
      'no XVANT-orchestrated configuration was benchmarked',
    );
    receipts['benchmark-v1'] = {
      ...full,
      runtimes: ['xvant-orchestrated', 'reference-solution', 'noop'],
    };
    expect(unmet(receipts)['benchmark-v1']).toBe(
      'no single-runtime baseline was benchmarked',
    );
  });
  it('lists deferred requirements without letting them hide unmet ones', () => {
    const deferred = { Linux: 'deferred by the operator' };
    const ready = evaluateRelease('local-v1', {
      receipts: complete(),
      currentSourceHash: NOW,
      deferred,
    });
    expect(ready.ready).toBe(true);
    expect(ready.requirements.at(-1)).toEqual({
      id: 'Linux',
      state: 'deferred',
      detail: 'deferred by the operator',
    });
    expect(
      evaluateRelease('local-v1', {
        receipts: {},
        currentSourceHash: NOW,
        deferred,
      }).ready,
    ).toBe(false);
  });
  it('local-beta does not need the native loop, evaluation or G08', () => {
    const receipts = complete();
    delete receipts.G08;
    delete receipts.G09;
    delete receipts['G08-live-native'];
    delete receipts['benchmark-v1'];
    receipts.G07 = ok();
    expect(
      evaluateRelease('local-beta', { receipts, currentSourceHash: NOW }).ready,
    ).toBe(true);
    expect(check(receipts).ready).toBe(false);
  });
});

it.each(['P10-clean-install', 'P10-soak', 'P10-package'])(
  'local-v1 needs a passing %s receipt, local-beta does not',
  (id) => {
    const receipts = complete();
    delete receipts[id];
    expect(unmet(receipts)).toEqual({ [id]: 'no receipt' });
    receipts[id] = { ...ok('older'), status: 'failed' };
    expect(unmet(receipts)).toEqual({ [id]: 'receipt is failed' });
    expect(
      evaluateRelease('local-beta', {
        receipts,
        currentSourceHash: NOW,
      }).requirements.some((r) => r.id === id),
    ).toBe(false);
  },
);
