import { describe, expect, it } from 'vitest';
import type {
  ChallengeNode,
  LessonEdge,
  SolutionNode,
} from '../../contracts/src/lessons.ts';
import {
  challengeOverlap,
  failureSignature,
  lessonsToMarkdown,
  lessonsToMermaid,
  renderLessons,
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
