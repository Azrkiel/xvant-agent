import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLiveMcp } from './live-mcp.ts';
import { runLiveHandoff } from './live-handoff.ts';

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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-live-gates-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('delivers a value each runtime can only obtain through the MCP bridge', async () => {
  const report = await runLiveMcp(root, { runtimes, timeoutMs: 20000 });
  expect(report.problems).toEqual([]);
  expect(report.turns.map((t) => t.runtimeKind)).toEqual([
    'codex',
    'claude',
    'opencode',
  ]);
  for (const turn of report.turns) {
    expect(turn.verification).toBe('passed');
    expect(turn.receipts).toContainEqual({
      tool: 'file.read',
      status: 'succeeded',
    });
  }
}, 120000);

it('fails a runtime that never calls the bridge', async () => {
  const report = await runLiveMcp(root, {
    runtimes: {
      ...runtimes,
      codex: {
        executable: process.execPath,
        prefixArgs: [fixture('codex-live-peer.mjs'), 'no-mcp'],
      },
    },
    kinds: ['codex'],
    timeoutMs: 20000,
  });
  expect(report.problems).toContain(
    'codex: no file.read call reached the bridge',
  );
}, 60000);

it('continues a task on another runtime from the sealed packet alone', async () => {
  const report = await runLiveHandoff(root, { runtimes, timeoutMs: 20000 });
  expect(report.problems).toEqual([]);
  expect(report.from.runtimeKind).toBe('codex');
  expect(report.to.runtimeKind).toBe('claude');
  expect(report.from.state).toBe('accepted');
  expect(report.to.state).toBe('accepted');
  expect(report.requiredFacts.present).toBe(report.requiredFacts.expected);
  expect(report.sentinelsAbsent).toEqual({ prompt: true, patch: true });
  expect(report.recipientChangedFiles).toEqual(['src/fetch.mjs']);
  expect(report.promptChars).toBeLessThanOrEqual(10000);
}, 120000);
