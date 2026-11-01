import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { challengeId } from './lessons.ts';
import type {
  ChallengeInput,
  SolutionInput,
} from '../../contracts/src/lessons.ts';

let root: string;
let now: number;
let store: Store;
const open = (owner = 'controller') =>
  new Store(join(root, 'state.sqlite'), { owner, now: () => now });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-lessons-'));
  now = 1000;
  store = open();
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const failure = (ms: number) =>
  'Checks failed: unit\n\n### Output of unit\nAssertionError: expected sum(2, 2) to equal 4, got 3 (' +
  ms +
  ' ms)';
const challenge = (
  text: string,
  extra: Partial<ChallengeInput> = {},
): ChallengeInput => ({
  projectId: 'project',
  failure: text,
  source: 'node',
  context: 'Add a sum helper',
  files: ['src/sum.js'],
  provenance: { graphId: 'run1', taskId: 'run1-sum-1' },
  ...extra,
});
const solution = (
  summary: string,
  extra: Partial<SolutionInput> = {},
): SolutionInput => ({
  projectId: 'project',
  summary,
  files: ['src/sum.js'],
  diff: '--- a/src/sum.js\n+++ b/src/sum.js\n-  return a + b - 1;\n+  return a + b;\n',
  checks: ['unit'],
  provenance: { graphId: 'run1', taskId: 'run1-sum-2', alias: 'claude-1' },
  ...extra,
});

describe('lesson graph', () => {
  it('records one node per failure across runs and counts occurrences', () => {
    const first = store.lessons.recordChallenge(challenge(failure(12)));
    now = 2000;
    const second = store.lessons.recordChallenge(
      challenge(failure(40), {
        files: ['test/sum.test.js'],
        provenance: { graphId: 'run2' },
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.id).toBe(challengeId(failure(99)));
    expect(second).toMatchObject({
      occurrences: 2,
      firstSeenAt: 1000,
      lastSeenAt: 2000,
      files: ['src/sum.js', 'test/sum.test.js'],
      seenIn: [{ graphId: 'run1', taskId: 'run1-sum-1' }, { graphId: 'run2' }],
    });
    expect(second.title).toBe(
      'Checks failed: unit | AssertionError: expected sum(2, 2) to equal 4, got 3 (40 ms)',
    );
    expect(store.lessons.nodes('project')).toHaveLength(1);
  });

  it('finds what fixed a failure, verified fixes first, and what did not work', () => {
    const ch = store.lessons.recordChallenge(challenge(failure(1)));
    const dead = store.lessons.recordSolution(
      solution('Changed the test to expect 3', {
        files: ['test/sum.test.js'],
        diff: '-expect(4)\n+expect(3)',
        checks: [],
      }),
    );
    const unverified = store.lessons.recordSolution(
      solution('Rewrote sum without checks', { checks: [], diff: 'x' }),
    );
    const fix = store.lessons.recordSolution(
      solution('Removed the off-by-one in sum'),
    );
    store.lessons.link('project', ch.id, dead.id, 'not_solved_by');
    store.lessons.link('project', ch.id, unverified.id, 'solved_by');
    now = 1500;
    store.lessons.link('project', ch.id, fix.id, 'solved_by');

    // The same failure, observed later with different numbers.
    const [match, ...rest] = store.lessons.find('project', {
      query: failure(77),
    });
    expect(rest).toHaveLength(0);
    expect(match!.exact).toBe(true);
    expect(match!.solutions.map((s) => s.solution.id)).toEqual([
      fix.id,
      unverified.id,
    ]);
    expect(match!.deadEnds.map((d) => d.solution.id)).toEqual([dead.id]);

    // A description of the problem in other words finds it too.
    const similar = store.lessons.find('project', {
      query: 'unit: AssertionError expected sum to equal, got wrong value',
    });
    expect(similar.map((m) => [m.challenge.id, m.exact])).toEqual([
      [ch.id, false],
    ]);
    // Unrelated failures and other projects find nothing.
    expect(
      store.lessons.find('project', {
        query: 'Checks failed: lint\nerror no-unused-vars',
      }),
    ).toEqual([]);
    expect(store.lessons.find('other', { query: failure(1) })).toEqual([]);
  });

  it('ranks by feedback from reuse', () => {
    const ch = store.lessons.recordChallenge(challenge(failure(1)));
    const a = store.lessons.recordSolution(solution('Fix A', { diff: 'a' }));
    const b = store.lessons.recordSolution(solution('Fix B', { diff: 'b' }));
    store.lessons.link('project', ch.id, a.id, 'solved_by');
    store.lessons.link('project', ch.id, b.id, 'solved_by');
    const order = () =>
      store.lessons
        .find('project', { query: failure(1) })[0]!
        .solutions.map((s) => s.solution.summary);
    // Equal evidence: the most recent first.
    now = 1100;
    store.lessons.link('project', ch.id, b.id, 'solved_by');
    expect(order()).toEqual(['Fix B', 'Fix A']);
    // B keeps failing when suggested; A keeps helping.
    store.lessons.recordUsage('project', [b.id], false);
    store.lessons.recordUsage('project', [b.id], false);
    store.lessons.recordUsage('project', [a.id, a.id, 'sol_missing'], true);
    expect(order()).toEqual(['Fix A', 'Fix B']);
    expect(store.lessons.get('project', a.id)).toMatchObject({
      usage: { suggested: 1, succeeded: 1, failed: 0 },
    });
    expect(
      store.lessons.edges('project', ch.id).find((e) => e.to === b.id),
    ).toMatchObject({ count: 2, firstAt: 1000, lastAt: 1100 });
  });

  it('deduplicates identical solutions and validates edges', () => {
    const ch = store.lessons.recordChallenge(challenge(failure(1)));
    const next = store.lessons.recordChallenge(
      challenge('Checks failed: lint\nerror: no-unused-vars'),
    );
    const one = store.lessons.recordSolution(solution('Same', { checks: [] }));
    const two = store.lessons.recordSolution(solution('Same'));
    expect(two.id).toBe(one.id);
    expect(two.checks).toEqual(['unit']);
    expect(() =>
      store.lessons.link('project', one.id, ch.id, 'solved_by'),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      store.lessons.link('project', ch.id, next.id, 'solved_by'),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      store.lessons.link('project', ch.id, one.id, 'followed_by'),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      store.lessons.link('project', ch.id, 'sol_nope', 'solved_by'),
    ).toThrow('NOT_FOUND');
    expect(
      store.lessons.link('project', ch.id, next.id, 'followed_by'),
    ).toMatchObject({ relation: 'followed_by', count: 1 });
  });

  it('removes credential-shaped text and survives a reopen', () => {
    const key = 'sk-ant-' + 'a'.repeat(30);
    const ch = store.lessons.recordChallenge(
      challenge('Request failed: 401 with key ' + key),
    );
    const fix = store.lessons.recordSolution(
      solution('Read the key from the environment, not ' + key, {
        diff: '-const key = "' + key + '"\n+const key = process.env.KEY',
      }),
    );
    store.lessons.link('project', ch.id, fix.id, 'solved_by');
    store.close();
    store = open('next');
    const all = JSON.stringify([
      store.lessons.nodes('project'),
      store.lessons.edges('project'),
    ]);
    expect(all).not.toContain(key);
    expect(all).toContain('[REDACTED]');
    expect(
      store.lessons.find('project', { query: 'Request failed: 401' }),
    ).toHaveLength(1);
  });
});
