import { describe, it, expect } from 'vitest';
import { validateTestReport } from '../scripts/gate-policy.ts';
const expected = { 'packages/core/src/task.test.ts': 2 };
function report() {
  return {
    success: true,
    numTotalTests: 2,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: 'C:/work/XVANT/packages/core/src/task.test.ts',
        status: 'passed',
        assertionResults: [{ status: 'passed' }, { status: 'passed' }],
      },
    ],
  };
}
describe('offline gate policy', () => {
  it('accepts a complete passing report', () =>
    expect(validateTestReport(report(), expected)).toEqual({
      total: 2,
      suites: { 'packages/core/src/task.test.ts': 2 },
    }));
  it('normalizes Windows paths', () => {
    const r = report();
    r.testResults[0]!.name = r.testResults[0]!.name.replaceAll('/', '\\');
    expect(validateTestReport(r, expected).total).toBe(2);
  });
  it.each(['pending', 'skipped', 'todo', 'failed'])(
    'rejects %s tests',
    (status) => {
      const r = report();
      r.testResults[0]!.assertionResults[0]!.status = status;
      expect(() => validateTestReport(r, expected)).toThrow();
    },
  );
  it('rejects a missing suite', () =>
    expect(() =>
      validateTestReport({ ...report(), testResults: [] }, expected),
    ).toThrow());
  it('rejects reduced discovery', () =>
    expect(() =>
      validateTestReport(report(), { 'packages/core/src/task.test.ts': 3 }),
    ).toThrow());
  it('rejects inconsistent total counts', () =>
    expect(() =>
      validateTestReport({ ...report(), numTotalTests: 3 }, expected),
    ).toThrow());
  it('rejects duplicate suite identities', () => {
    const r = report();
    r.testResults.push(r.testResults[0]!);
    expect(() => validateTestReport(r, expected)).toThrow();
  });
  it('rejects malformed reports', () =>
    expect(() => validateTestReport({}, expected)).toThrow());
  it('rejects an unsuccessful run even with passed assertions', () =>
    expect(() =>
      validateTestReport({ ...report(), success: false }, expected),
    ).toThrow());
  it('rejects failed suites with no test failures', () => {
    const r = report();
    r.testResults[0]!.status = 'failed';
    expect(() => validateTestReport(r, expected)).toThrow();
  });
  it('rejects unknown additional skipped suites', () => {
    const r = report();
    r.testResults.push({
      name: 'extra.test.ts',
      status: 'pending',
      assertionResults: [],
    });
    expect(() => validateTestReport(r, expected)).toThrow();
  });
  it('rejects empty or invalid expected suite requirements', () => {
    expect(() => validateTestReport(report(), {})).toThrow();
    expect(() => validateTestReport(report(), { 'task.test.ts': 0 })).toThrow();
  });
});
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBounded } from '../scripts/bounded-run.ts';
describe('bounded gate stage', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  it('returns the exit code and the logged output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xvant-bounded-'));
    try {
      const logPath = join(dir, 'stage.log');
      const run = await runBounded(
        process.execPath,
        ['-e', 'console.log("out"); console.error("err"); process.exit(3)'],
        { cwd: dir, timeoutMs: 15000, logPath },
      );
      expect(run).toMatchObject({ exitCode: 3, timedOut: false });
      expect(run.output).toContain('out');
      expect(run.output).toContain('err');
      expect(readFileSync(logPath, 'utf8')).toBe(run.output);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
  it('fails fast on timeout and stops descendants holding the output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xvant-bounded-'));
    try {
      const logPath = join(dir, 'stage.log');
      const parent = [
        'const { spawn } = require("node:child_process");',
        'const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
        'console.log("grandchild " + c.pid);',
        'setInterval(() => {}, 1000);',
      ].join('\n');
      const started = Date.now();
      const run = await runBounded(process.execPath, ['-e', parent], {
        cwd: dir,
        timeoutMs: 3000,
        logPath,
      });
      expect(Date.now() - started).toBeLessThan(15000);
      expect(run).toMatchObject({ exitCode: 1, timedOut: true });
      expect(run.output).toContain('Timed out after 3000 ms');
      const pid = Number(/grandchild (\d+)/.exec(run.output)?.[1]);
      expect(pid).toBeGreaterThan(0);
      for (let i = 0; i < 50 && alive(pid); i += 1)
        await new Promise((r) => setTimeout(r, 100));
      expect(alive(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
import { phaseSuites } from '../scripts/gate-policy.ts';
it('Phase 2 gate requires storage, process, auth, recovery and service suites', () => {
  const suites = phaseSuites('02');
  for (const file of [
    'packages/storage/src/store.test.ts',
    'packages/storage/src/artifacts.test.ts',
    'packages/supervisor/src/index.test.ts',
    'packages/policy/src/index.test.ts',
    'apps/controller/src/durable.test.ts',
    'apps/controller/src/service.test.ts',
    'apps/controller/src/http/server.test.ts',
    'tests/faults/crash.test.ts',
  ])
    expect(suites[file]).toBeGreaterThan(0);
  expect(() => phaseSuites('09')).toThrow();
  const phase8 = phaseSuites('08');
  for (const [file, minimum] of Object.entries(phaseSuites('07')))
    expect(phase8[file]).toBe(minimum);
  for (const file of [
    'packages/native-agent/src/loop.test.ts',
    'apps/controller/src/native-turn-runner.test.ts',
    'apps/controller/src/native-loop-fixture.test.ts',
  ])
    expect(phase8[file]).toBeGreaterThan(0);
  const phase6 = phaseSuites('06');
  for (const [file, minimum] of Object.entries(phaseSuites('05')))
    expect(phase6[file]).toBe(minimum);
  expect(phase6['apps/controller/src/orchestrator.test.ts']).toBeGreaterThan(0);
  const phase5 = phaseSuites('05');
  for (const [file, minimum] of Object.entries(phaseSuites('04')))
    expect(phase5[file]).toBe(minimum);
  for (const file of [
    'packages/tools/src/registry.test.ts',
    'packages/tools/src/mcp.test.ts',
    'packages/skills/src/bundled.test.ts',
    'packages/policy/src/runtimes.test.ts',
    'apps/controller/src/tools-fixture.test.ts',
  ])
    expect(phase5[file]).toBeGreaterThan(0);
  const phase4 = phaseSuites('04');
  for (const [file, minimum] of Object.entries(phaseSuites('03')))
    expect(phase4[file]).toBe(minimum);
  for (const file of [
    'packages/context/src/packet.test.ts',
    'packages/context/src/retrieval.test.ts',
    'packages/storage/src/memory.test.ts',
    'packages/memory/src/relevance.test.ts',
    'packages/context/src/handoff.test.ts',
    'packages/context/src/inspect.test.ts',
    'packages/context/src/transfer.test.ts',
    'apps/controller/src/handoff-fixture.test.ts',
  ])
    expect(phase4[file]).toBeGreaterThan(0);
  expect(
    Object.values(phaseSuites('01')).reduce((a, b) => a + b, 0),
  ).toBeGreaterThanOrEqual(110);
});
