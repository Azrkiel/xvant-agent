import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rosterProblems, runLiveRoster } from './live-roster.ts';

const fixture = (name: string) =>
  fileURLToPath(new URL('../../../tests/fixtures/' + name, import.meta.url));
const runtimes = {
  codex: {
    executable: process.execPath,
    prefixArgs: [fixture('codex-live-peer.mjs'), 'write'],
  },
  claude: {
    executable: process.execPath,
    prefixArgs: [fixture('claude-live-peer.mjs'), 'write'],
  },
  opencode: {
    executable: process.execPath,
    prefixArgs: [fixture('opencode-cli.mjs'), 'tools'],
  },
};
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-roster-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('runs the 2/3/5 roster with distinct sessions, resume and interruption', async () => {
  const report = await runLiveRoster(root, {
    runtimes,
    concurrency: 3,
    timeoutMs: 20000,
    resume: true,
    interrupt: true,
  });
  expect(report.problems).toEqual([]);
  const initial = report.turns.filter((t) => t.kind === 'initial');
  expect(initial.map((t) => t.alias).sort()).toEqual([
    'claude-1',
    'claude-2',
    'claude-3',
    'codex-1',
    'codex-2',
    'opencode-1',
    'opencode-2',
    'opencode-3',
    'opencode-4',
    'opencode-5',
  ]);
  expect(initial.every((t) => t.accepted)).toBe(true);
  expect(report.maxObservedConcurrency).toBeLessThanOrEqual(3);
  expect(report.turns.filter((t) => t.kind === 'resume')).toHaveLength(3);
  expect(
    report.turns.filter((t) => t.kind === 'interrupt').map((t) => t.outcome),
  ).toEqual(['cancelled', 'cancelled', 'cancelled']);
  expect(report.activeCount).toBe(0);
}, 180000);

it('reports a worker that changed files outside its own', () =>
  expect(
    rosterProblems({
      counts: { codex: 1, claude: 0, opencode: 0 },
      turns: [
        {
          alias: 'codex-1',
          runtimeKind: 'codex',
          kind: 'initial',
          connectionId: 'c',
          state: 'accepted',
          status: 'accepted',
          outcome: 'completed',
          sessionId: 's',
          runId: 'r',
          verification: 'passed',
          changedFiles: ['codex-1.txt', 'other.txt'],
          accepted: true,
          tokens: null,
          auth: null,
          failure: null,
          elapsedMs: 1,
        },
      ],
    }),
  ).toEqual(['codex-1 changed ["codex-1.txt","other.txt"]']));
