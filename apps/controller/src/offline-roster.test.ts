import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../packages/storage/src/store.ts';
import { rosterFailures, runControllerRoster } from './offline-roster.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-roster-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
it('routes ten concurrent named workers to their own sessions and outcomes', async () => {
  const report = await runControllerRoster(root);
  expect(rosterFailures(report)).toEqual([]);
  expect(report.results.map((result) => result.workerId)).toEqual([
    'codex_1',
    'codex_2',
    'claude_1',
    'claude_2',
    'claude_3',
    'opencode_1',
    'opencode_2',
    'opencode_3',
    'opencode_4',
    'opencode_5',
  ]);
  const store = new Store(join(root, 'state.sqlite'), { owner: 'inspect' });
  try {
    // Each account block stays inside its runtime's quota group.
    expect(store.providers.blocked('opencode_account')?.connectionId).toBe(
      'connection_opencode_4',
    );
    const interrupts = store
      .events(0)
      .filter((event) => event.kind === 'provider.interrupt_requested')
      .map((event) => (event.payload as { connectionId: string }).connectionId)
      .sort();
    expect(interrupts).toEqual([
      'connection_claude_2',
      'connection_opencode_3',
    ]);
    expect(store.integrity()).toBe('ok');
  } finally {
    store.close();
  }
}, 60000);
it('detects misrouted roster results', () => {
  const result = {
    workerId: 'claude_1',
    runtimeKind: 'claude' as const,
    scenario: 'permission',
    mode: 'resume' as const,
    nativeSessionId: 's',
    state: 'ready_for_acceptance',
    outcome: 'completed',
    verification: 'passed',
    failure: null,
    interruptActor: 'operator_claude_2',
    outgoing: ['fixture/start', 'fixture/interrupt'],
  };
  const problems = rosterFailures({
    classification: 'offline',
    liveProvidersTested: [],
    results: [result],
    blocked: { codex: 'QUOTA_BLOCKED', claude: null, opencode: null },
    activeCount: 1,
    accepted: true,
  });
  expect(problems).toEqual(
    expect.arrayContaining([
      'roster size',
      'claude_1 stray interrupt',
      'claude_1 interrupt routing',
      'claude_1 denial routing',
      'opencode block',
      'block isolation',
      'owned processes',
      'no acceptance',
    ]),
  );
});
