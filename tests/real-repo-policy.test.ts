import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  realRepoProblems,
  type RunFacts,
} from '../scripts/real-repo-policy.ts';

const checkout = { head: 'a'.repeat(40), branch: 'main', status: '' };
const good: RunFacts = {
  phase: 'ready',
  checks: [{ id: 'check1', status: 'passed' }],
  review: { approve: true, findings: [] },
  integration: { baseCommit: 'a'.repeat(40), head: 'b'.repeat(40) },
};
const problems = (
  run: RunFacts | null,
  over: Partial<Parameters<typeof realRepoProblems>[0]> = {},
) =>
  realRepoProblems({
    run,
    before: checkout,
    after: checkout,
    sourceBefore: 's1',
    sourceAfter: 's1',
    ...over,
  });

it('a ready, checked, approved result that left the checkout alone counts', () => {
  expect(problems(good)).toEqual([]);
});

it('names every reason a run does not count', () => {
  expect(problems(null)).toEqual(['The run recorded no root task']);
  expect(
    problems({ ...good, phase: 'needs_attention', reason: 'unknown turn' }),
  ).toEqual(['The run ended needs_attention: unknown turn']);
  // A run nobody checked proves nothing, however it ended.
  expect(problems({ ...good, checks: [] })).toEqual([
    'No registered check ran on the combined result',
  ]);
  expect(
    problems({
      ...good,
      checks: [
        { id: 'check1', status: 'passed' },
        { id: 'check2', status: 'failed' },
      ],
    }),
  ).toEqual(['Check check2 failed']);
  expect(
    problems({ ...good, review: { approve: false, findings: ['no tests'] } }),
  ).toEqual(['The review did not approve: no tests']);
  expect(problems({ ...good, review: null })).toEqual([
    'The review did not approve: no review',
  ]);
  expect(
    problems({
      ...good,
      integration: { baseCommit: 'a'.repeat(40), head: 'a'.repeat(40) },
    }),
  ).toEqual(['The result changes nothing']);
  expect(problems({ ...good, integration: null })).toEqual([
    'The result changes nothing',
  ]);
});

it('a changed checkout or source tree fails an otherwise good run', () => {
  for (const after of [
    { ...checkout, head: 'c'.repeat(40) },
    { ...checkout, branch: 'xvant/x1' },
    { ...checkout, status: ' M README.md' },
  ])
    expect(problems(good, { after })).toEqual([
      "The repository's own checkout changed during the run",
    ]);
  expect(problems(good, { sourceAfter: 's2' })).toEqual([
    'Source changed during the run',
  ]);
});

it('the script refuses to start without approval, a repository, an objective and a check', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['scripts/real-repo-run.mjs', ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
  for (const args of [
    ['--repo', '.', '--objective', 'x', '--check', 'node -v'],
    ['--approve-live', '--objective', 'x', '--check', 'node -v'],
    ['--approve-live', '--repo', '.', '--check', 'node -v'],
    ['--approve-live', '--repo', '.', '--objective', 'x'],
  ]) {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  }
}, 60000);
