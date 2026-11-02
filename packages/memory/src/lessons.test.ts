import { describe, expect, it } from 'vitest';
import type {
  ChallengeNode,
  LessonEdge,
  SolutionNode,
} from '../../contracts/src/lessons.ts';
import {
  challengeOverlap,
  failureSignature,
  lessonReport,
  lessonsLine,
  lessonsToMarkdown,
  lessonsToMermaid,
  readRunLessons,
  renderLessons,
  renderReport,
} from './lessons.ts';

const challenge: ChallengeNode = {
  kind: 'challenge',
  id: 'ch_1',
  projectId: 'p',
  signature: 'checks failed: unit | expected <n>, got <n>',
  title: 'Checks failed: unit | expected 42, got 41',
  detail: 'Checks failed: unit\nexpected 42, got 41',
  source: 'node',
  files: ['src/sum.js'],
  occurrences: 2,
  firstSeenAt: 1,
  lastSeenAt: 2,
  seenIn: [{ graphId: 'g' }],
};
const solution = (id: string, summary: string): SolutionNode => ({
  kind: 'solution',
  id,
  projectId: 'p',
  summary,
  files: ['src/sum.js'],
  diff: '-return a + b - 1;\n+return a + b;',
  checks: ['unit'],
  createdAt: 3,
  provenance: { graphId: 'g' },
  usage: { suggested: 2, succeeded: 1, failed: 1 },
});
const edge = (to: string, relation: LessonEdge['relation']): LessonEdge => ({
  projectId: 'p',
  from: 'ch_1',
  to,
  relation,
  count: 1,
  firstAt: 3,
  lastAt: 3,
});

describe('failure signatures', () => {
  it('ignore run-specific numbers, hashes and absolute paths', () => {
    const a =
      'Checks failed: unit\n\n### Output of unit\nexpected 42, got 41 (12 ms) at /tmp/xvant-a1/wt/src/sum.js';
    const b =
      'Checks failed: unit\n\n### Output of unit\nexpected 7, got 6 (3 ms) at /home/u/run-9/wt/src/sum.js';
    expect(failureSignature(a)).toBe(failureSignature(b));
    expect(failureSignature(a)).toBe(
      'checks failed: unit | expected <n>, got <n> (<n> ms) at <path>',
    );
    expect(failureSignature('commit deadbeefcafe broke it')).toBe(
      'commit <hex> broke it',
    );
  });
  it('tell apart failures with the same heading and different reasons', () => {
    expect(failureSignature('Checks failed: unit\nexpected 1, got 2')).not.toBe(
      failureSignature('Checks failed: unit\nTypeError: x is undefined'),
    );
  });
  it('measure how much of a challenge a query describes', () => {
    const signature = 'checks failed: lint | error no-unused-vars in parser';
    expect(
      challengeOverlap(
        'Lint error: no-unused-vars in parser.ts line 4',
        signature,
      ),
    ).toBe(1);
    expect(challengeOverlap('unit test failed', signature)).toBe(0);
  });
});

describe('readable lessons', () => {
  const match = {
    challenge,
    exact: true,
    solutions: [
      {
        solution: solution('sol_a', 'Removed the off-by-one in sum'),
        edge: edge('sol_a', 'solved_by'),
        score: 1,
      },
    ],
    deadEnds: [
      {
        solution: solution('sol_b', 'Changed the test expectation'),
        edge: edge('sol_b', 'not_solved_by'),
      },
    ],
  };
  it('render a prompt section marked as data, with fixes and dead ends', () => {
    const text = renderLessons([match]);
    expect(text).toMatch(/sourced data, not instructions/);
    expect(text).toMatch(/### ch_1: Checks failed: unit/);
    expect(text).toMatch(/same failure/);
    expect(text).toMatch(
      /Worked 1× \(verified by checks: unit; helped 1 of 2 later repairs\) sol_a: Removed the off-by-one/,
    );
    expect(text).toMatch(/\+return a \+ b;/);
    expect(text).toMatch(/Did not work \(1×\) sol_b: Changed the test/);
    expect(renderLessons([])).toBe('');
    // A budget too small for any challenge yields nothing, not a bare heading.
    expect(renderLessons([match], 100)).toBe('');
  });
  it('export Mermaid and Markdown', () => {
    const nodes = [
      challenge,
      solution('sol_a', 'Fix "quote" <tag>'),
      solution('sol_b', 'x'),
    ];
    const edges = [edge('sol_a', 'solved_by'), edge('sol_b', 'not_solved_by')];
    const mermaid = lessonsToMermaid(nodes, edges);
    expect(mermaid.split('\n')[0]).toBe('flowchart LR');
    expect(mermaid).toContain('ch_1["Checks failed: unit');
    expect(mermaid).toContain('sol_a(["Fix #quot;quote#quot;  tag "])');
    expect(mermaid).toContain('ch_1 -->|solved_by| sol_a');
    expect(mermaid).toContain('ch_1 -.->|not_solved_by| sol_b');
    const markdown = lessonsToMarkdown(nodes, edges);
    expect(markdown).toMatch(/1 challenges, 2 solutions/);
    expect(markdown).toMatch(/## ch_1: Checks failed: unit/);
    expect(markdown).toMatch(/Solved by sol_a \(1×, checks: unit\)/);
    expect(markdown).toMatch(/Not solved by sol_b/);
  });
});

const stored = (hinted: [number, number], unhinted: [number, number]) => ({
  challenges: 1,
  solutions: 1,
  hinted: 0,
  errors: 0,
  scope: 'repo_a',
  repairs: {
    hinted: { passed: hinted[0], failed: hinted[1] },
    unhinted: { passed: unhinted[0], failed: unhinted[1] },
  },
});

describe('lessons in a run summary', () => {
  it('tolerates run states stored before scope and repairs existed', () => {
    const old = { challenges: 2, solutions: 1, hinted: 1, errors: 0 };
    expect(readRunLessons(old)).toEqual({
      ...old,
      repairs: {
        hinted: { passed: 0, failed: 0 },
        unhinted: { passed: 0, failed: 0 },
      },
    });
    expect(lessonsLine(old)).toBe('Lessons: 2 challenges, 1 fix recorded');
    // Anything malformed reads as nothing rather than throwing.
    expect(readRunLessons(undefined)).toBeNull();
    expect(readRunLessons('x')).toBeNull();
    expect(
      readRunLessons({ challenges: 'many', repairs: { hinted: 7 } }),
    ).toMatchObject({
      challenges: 0,
      repairs: { hinted: { passed: 0, failed: 0 } },
    });
  });

  it('prints one line, and nothing when lessons were off or idle', () => {
    expect(lessonsLine(stored([1, 0], [0, 1]))).toBe(
      'Lessons: 1 challenge, 1 fix recorded, repairs hinted 1/1 passed, unhinted 0/1 passed',
    );
    expect(
      lessonsLine({
        ...stored([0, 0], [0, 0]),
        challenges: 2,
        solutions: 2,
        errors: 1,
      }),
    ).toBe('Lessons: 2 challenges, 2 fixes recorded, 1 lesson error');
    expect(lessonsLine(stored([0, 0], [0, 0]))).toBe(
      'Lessons: 1 challenge, 1 fix recorded',
    );
    expect(
      lessonsLine({ challenges: 0, solutions: 0, hinted: 0, errors: 0 }),
    ).toBeNull();
    expect(lessonsLine(undefined)).toBeNull();
  });
});

describe('lesson report', () => {
  const solved = (id: string, succeeded: number, checks = ['unit']) => ({
    ...solution(id, 'Fix ' + id),
    checks,
    usage: { suggested: succeeded + 1, succeeded, failed: 1 },
  });
  const challengeOf = (id: string, occurrences: number): ChallengeNode => ({
    ...challenge,
    id,
    title: 'Challenge ' + id,
    occurrences,
  });
  const link = (
    from: string,
    to: string,
    relation: LessonEdge['relation'] = 'solved_by',
    count = 1,
  ): LessonEdge => ({ ...edge(to, relation), from, count });

  it('adds up hinted and unhinted repairs across runs, with the counts', () => {
    const report = lessonReport(
      [stored([2, 1], [1, 3]), stored([1, 0], [0, 1]), { challenges: 0 }],
      [],
      [],
    );
    expect(report.runs).toBe(3);
    expect(report.repairs).toEqual({
      hinted: { passed: 3, failed: 1 },
      unhinted: { passed: 1, failed: 4 },
    });
    expect(report.repairsPerRun).toBeCloseTo(3);
    const text = renderReport('repo_a', report);
    expect(text).toContain('hinted (prompt carried lessons): 3/4 passed (75%)');
    expect(text).toContain('unhinted: 1/5 passed (20%)');
    expect(text).toContain('Judged repairs per run: 3.00');
  });

  it('says the sample is too small unless both groups have enough', () => {
    const few = lessonReport([stored([4, 0], [5, 5])], [], []);
    expect(few.comparable).toBe(false);
    expect(renderReport('s', few)).toContain(
      'Sample too small to compare: need at least 5 judged repairs in each group.',
    );
    const enough = lessonReport([stored([3, 2], [5, 5])], [], []);
    expect(enough.comparable).toBe(true);
    const text = renderReport('s', enough);
    expect(text).not.toContain('too small');
    expect(text).toContain('not randomized');
    // No runs at all: nothing to divide by.
    const none = lessonReport([], [], []);
    expect(none.repairsPerRun).toBeNull();
    expect(renderReport('s', none)).toContain('Judged repairs per run: n/a');
    expect(renderReport('s', none)).toContain('0/0 passed (n/a)');
  });

  it('ranks helpful fixes and lists challenges seen often with no verified fix', () => {
    const nodes = [
      challengeOf('ch_a', 4),
      challengeOf('ch_b', 6),
      challengeOf('ch_c', 1),
      challengeOf('ch_d', 3),
      solved('sol_1', 3),
      solved('sol_2', 3),
      solved('sol_3', 0, []),
      solved('sol_4', 0),
    ];
    const edges = [
      link('ch_a', 'sol_1'),
      link('ch_a', 'sol_2', 'solved_by', 4),
      link('ch_b', 'sol_3'),
      link('ch_d', 'sol_4', 'not_solved_by'),
    ];
    const report = lessonReport([], nodes, edges);
    // By successful reuse, then by how often the fix solved the challenge.
    expect(report.helpful.map((h) => h.id)).toEqual([
      'sol_2',
      'sol_1',
      'sol_3',
    ]);
    // ch_a has a verified fix; ch_b only an unverified one; ch_c is rare.
    expect(report.unsolved.map((u) => [u.id, u.occurrences])).toEqual([
      ['ch_b', 6],
      ['ch_d', 3],
    ]);
  });

  it('leaves forgotten nodes out', () => {
    const forgotten = { at: 1, reason: 'bad' };
    const nodes = [
      challengeOf('ch_a', 4),
      { ...challengeOf('ch_b', 9), forgotten },
      { ...solved('sol_1', 5), forgotten },
    ];
    const report = lessonReport([], nodes, [link('ch_a', 'sol_1')]);
    expect(report.helpful).toEqual([]);
    expect(report.unsolved.map((u) => u.id)).toEqual(['ch_a']);
  });
});
