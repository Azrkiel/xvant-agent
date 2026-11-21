import { expect, it } from 'vitest';
import { offlineCheckIds, validateCiReceipt } from '../scripts/ci-policy.ts';
import { phaseSuites } from '../scripts/gate-policy.ts';

const revision = 'a'.repeat(40),
  hash = 'b'.repeat(64);
function receipt() {
  const suites = phaseSuites('10');
  const count = Object.values(suites).reduce((a, b) => a + b, 0);
  return {
    gateId: 'G10',
    status: 'passed',
    classification: 'offline',
    qualificationScope: 'offline-release',
    liveProvidersTested: [],
    sourceRevision: revision,
    dirtyTreeHash: hash,
    checks: offlineCheckIds.map((id) => ({
      id,
      exitCode: 0,
      ...(id === 'tests'
        ? { expectedCount: count, observedCount: count, suites }
        : {}),
    })),
    artifacts: [
      ...offlineCheckIds.map((id) => '.artifacts/' + id + '.log'),
      '.artifacts/tests.json',
      'coverage/coverage-summary.json',
      '.artifacts/source-manifest.json',
    ].map((path) => ({ path, sha256: hash })),
  };
}
it('admits only the complete source-bound offline receipt', () => {
  expect(validateCiReceipt(receipt(), revision, hash).checks).toHaveLength(31);
});
it('rejects stale revisions and dirty content hashes', () => {
  expect(() => validateCiReceipt(receipt(), 'c'.repeat(40), hash)).toThrow(
    /source/,
  );
  expect(() => validateCiReceipt(receipt(), revision, 'd'.repeat(64))).toThrow(
    /source/,
  );
});
it.each(['failed', 'unavailable'])('rejects a %s gate', (status) => {
  expect(() =>
    validateCiReceipt({ ...receipt(), status }, revision, hash),
  ).toThrow();
});
it('rejects a missing required gate stage even when the shell succeeded', () => {
  const r = receipt();
  r.checks = r.checks.filter((check) => check.id !== 'browser-fixture');
  expect(() => validateCiReceipt(r, revision, hash)).toThrow(
    /required gate check/,
  );
});
it('rejects a failed check and a duplicate replacing a required check', () => {
  const r = receipt();
  r.checks[0]!.exitCode = 1;
  expect(() => validateCiReceipt(r, revision, hash)).toThrow();
  r.checks[0] = r.checks[1]!;
  expect(() => validateCiReceipt(r, revision, hash)).toThrow(
    /required gate check/,
  );
});
it('rejects reduced or undiscovered tests', () => {
  const r = receipt();
  const tests = r.checks.find((check) => check.id === 'tests')!;
  tests.observedCount = 1;
  expect(() => validateCiReceipt(r, revision, hash)).toThrow(/required tests/);
  tests.observedCount = tests.expectedCount!;
  tests.suites = {};
  expect(() => validateCiReceipt(r, revision, hash)).toThrow(/required tests/);
});
it('rejects live results and missing structured diagnostics', () => {
  expect(() =>
    validateCiReceipt({ ...receipt(), classification: 'live' }, revision, hash),
  ).toThrow();
  expect(() =>
    validateCiReceipt({ ...receipt(), artifacts: [] }, revision, hash),
  ).toThrow(/artifact/);
});
