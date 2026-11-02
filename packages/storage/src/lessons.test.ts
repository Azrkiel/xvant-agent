import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { challengeId } from './lessons.ts';
import { ArtifactStore, backupSnapshot, restoreSnapshot } from './artifacts.ts';
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

  it('survive a verified snapshot, which rejects a changed lesson schema', async () => {
    const ch = store.lessons.recordChallenge(challenge(failure(1)));
    const fix = store.lessons.recordSolution(
      solution('Removed the off-by-one'),
    );
    store.lessons.link('project', ch.id, fix.id, 'solved_by');
    await backupSnapshot(
      store,
      new ArtifactStore(join(root, 'objects')),
      join(root, 'backup'),
    );
    await restoreSnapshot(join(root, 'backup'), join(root, 'restored'));
    const restored = new Store(join(root, 'restored', 'state.sqlite'), {
      owner: 'restored',
      // Snapshots keep the controller lease; open after it lapses.
      now: () => now + 60_000,
    });
    try {
      expect(
        restored.lessons
          .find('project', { query: failure(5) })[0]!
          .solutions.map((s) => s.solution.id),
      ).toEqual([fix.id]);
    } finally {
      restored.close();
    }
    const dbPath = join(root, 'backup', 'state.sqlite');
    const db = new Database(dbPath);
    db.exec('ALTER TABLE lesson_edges ADD COLUMN extra TEXT');
    db.close();
    const manifestPath = join(root, 'backup', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      database: { sha256: string };
    };
    manifest.database.sha256 = createHash('sha256')
      .update(readFileSync(dbPath))
      .digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(
      restoreSnapshot(join(root, 'backup'), join(root, 'second')),
    ).rejects.toThrow('SCHEMA_UNSUPPORTED');
  });
});

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
];
/** Distinct failures: numbers are normalized away, so words must differ. */
const failureOf = (i: number) =>
  'Build failed: ' + WORDS[i] + '\nError: ' + WORDS[i] + ' module missing';

describe('forgetting lessons', () => {
  const setup = () => {
    const ch = store.lessons.recordChallenge(challenge(failure(1)));
    const fix = store.lessons.recordSolution(
      solution('Removed the off-by-one'),
    );
    const dead = store.lessons.recordSolution(
      solution('Changed the test', { diff: 'x', checks: [] }),
    );
    store.lessons.link('project', ch.id, fix.id, 'solved_by');
    store.lessons.link('project', ch.id, dead.id, 'not_solved_by');
    return { ch, fix, dead };
  };
  const found = () => store.lessons.find('project', { query: failure(9) });

  it('marks a challenge with when and why, keeps it, and stops matching it', () => {
    const { ch } = setup();
    expect(found()).toHaveLength(1);
    now = 5000;
    const marked = store.lessons.forget('project', ch.id, '  wrong fix  ');
    expect(marked.forgotten).toEqual({ at: 5000, reason: 'wrong fix' });
    expect(store.lessons.get('project', ch.id)).toMatchObject({
      forgotten: { at: 5000, reason: 'wrong fix' },
    });
    expect(store.lessons.nodes('project')).toHaveLength(3);
    expect(store.lessons.edges('project')).toHaveLength(2);
    // Neither the exact failure nor a description of it finds it again.
    expect(found()).toEqual([]);
    expect(
      store.lessons.find('project', {
        query: 'unit: AssertionError expected sum to equal, got wrong value',
      }),
    ).toEqual([]);
  });

  it('stops offering a forgotten solution as a fix or as a dead end', () => {
    const { fix, dead } = setup();
    expect(found()[0]!.solutions.map((s) => s.solution.id)).toEqual([fix.id]);
    expect(found()[0]!.deadEnds.map((s) => s.solution.id)).toEqual([dead.id]);
    store.lessons.forget('project', dead.id, 'misleading');
    expect(found()[0]!.deadEnds).toEqual([]);
    expect(found()[0]!.solutions).toHaveLength(1);
    store.lessons.forget('project', fix.id, 'broke the build');
    // Nothing learned is left to show.
    expect(found()).toEqual([]);
    expect(store.lessons.get('project', fix.id)).toMatchObject({
      forgotten: { reason: 'broke the build' },
    });
  });

  it('keeps a challenge forgotten when it is seen again', () => {
    const { ch } = setup();
    store.lessons.forget('project', ch.id, 'noise');
    now = 7000;
    const again = store.lessons.recordChallenge(
      challenge(failure(3), { provenance: { graphId: 'run9' } }),
    );
    expect(again.id).toBe(ch.id);
    expect(again).toMatchObject({
      occurrences: 2,
      lastSeenAt: 7000,
      forgotten: { reason: 'noise' },
    });
    expect(store.lessons.get('project', ch.id).forgotten).toBeDefined();
    expect(found()).toEqual([]);
  });

  it('keeps a solution forgotten when the same change is recorded again', () => {
    const { ch, fix } = setup();
    store.lessons.forget('project', fix.id, 'bad');
    const again = store.lessons.recordSolution(
      solution('Removed the off-by-one', { checks: ['unit', 'lint'] }),
    );
    expect(again.id).toBe(fix.id);
    expect(again).toMatchObject({
      checks: ['unit', 'lint'],
      forgotten: { reason: 'bad' },
    });
    // Linking and reuse feedback do not revive it either.
    store.lessons.link('project', ch.id, fix.id, 'solved_by');
    store.lessons.recordUsage('project', [fix.id], true);
    expect(store.lessons.get('project', fix.id).forgotten).toBeDefined();
    expect(found()[0]!.solutions.map((s) => s.solution.id)).not.toContain(
      fix.id,
    );
  });

  it('forgets once, rejects an empty reason and an unknown id', () => {
    const { ch } = setup();
    for (const reason of ['', '   ', '\n'])
      expect(() => store.lessons.forget('project', ch.id, reason)).toThrow(
        'INVALID_INPUT',
      );
    expect(store.lessons.get('project', ch.id).forgotten).toBeUndefined();
    expect(() => store.lessons.forget('project', 'ch_missing', 'why')).toThrow(
      'NOT_FOUND',
    );
    expect(() => store.lessons.forget('other', ch.id, 'why')).toThrow(
      'NOT_FOUND',
    );
    now = 2000;
    store.lessons.forget('project', ch.id, 'first');
    now = 3000;
    expect(store.lessons.forget('project', ch.id, 'second').forgotten).toEqual({
      at: 2000,
      reason: 'first',
    });
  });

  it('removes credential-shaped text from the reason', () => {
    const { ch } = setup();
    const key = 'sk-ant-api03-' + 'a'.repeat(40);
    const node = store.lessons.forget('project', ch.id, 'leaked ' + key);
    expect(node.forgotten!.reason).not.toContain(key);
  });

  it('survives a verified snapshot with forgotten nodes in it', async () => {
    const { ch, fix } = setup();
    store.lessons.forget('project', ch.id, 'old');
    store.lessons.forget('project', fix.id, 'older');
    await backupSnapshot(
      store,
      new ArtifactStore(join(root, 'objects')),
      join(root, 'backup'),
    );
    await restoreSnapshot(join(root, 'backup'), join(root, 'restored'));
    const restored = new Store(join(root, 'restored', 'state.sqlite'), {
      owner: 'restored',
      now: () => now + 60_000,
    });
    try {
      expect(restored.lessons.get('project', ch.id)).toMatchObject({
        forgotten: { reason: 'old' },
      });
      expect(restored.lessons.nodes('project')).toHaveLength(3);
      expect(restored.lessons.find('project', { query: failure(5) })).toEqual(
        [],
      );
    } finally {
      restored.close();
    }
  });
});

describe('the lesson cap', () => {
  let capped: Store | undefined;
  afterEach(() => capped?.close());
  const openCapped = (cap: number) => {
    capped = new Store(join(root, 'capped.sqlite'), {
      owner: 'capped',
      now: () => now,
      lessonCap: cap,
    });
    return capped;
  };
  /** Nothing dangles: every edge joins two nodes, every text row has a node. */
  const expectConsistent = () => {
    const db = new Database(join(root, 'capped.sqlite'), { readonly: true });
    try {
      const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
      expect(
        n(
          'SELECT COUNT(*) AS n FROM lesson_text WHERE rowid NOT IN (SELECT rowid FROM lesson_nodes)',
        ),
      ).toBe(0);
      expect(
        n(
          'SELECT COUNT(*) AS n FROM lesson_edges e WHERE NOT EXISTS (SELECT 1 FROM lesson_nodes WHERE project_id=e.project_id AND id=e.from_id) OR NOT EXISTS (SELECT 1 FROM lesson_nodes WHERE project_id=e.project_id AND id=e.to_id)',
        ),
      ).toBe(0);
      expect(n('SELECT COUNT(*) AS n FROM lesson_text')).toBe(
        n('SELECT COUNT(*) AS n FROM lesson_nodes'),
      );
    } finally {
      db.close();
    }
  };

  it('prunes the least useful, then the oldest, and leaves nothing dangling', () => {
    const s = openCapped(6);
    // An old challenge with a verified fix that worked in reuse.
    const old = s.lessons.recordChallenge(challenge(failureOf(0)));
    const fix = s.lessons.recordSolution(solution('Added the module'));
    s.lessons.link('project', old.id, fix.id, 'solved_by');
    s.lessons.recordUsage('project', [fix.id], true);
    // An old challenge with an unverified fix that was never reused.
    now = 1001;
    const weak = s.lessons.recordChallenge(challenge(failureOf(1)));
    const bare = s.lessons.recordSolution(
      solution('Guessed', { diff: 'g', checks: [] }),
    );
    s.lessons.link('project', weak.id, bare.id, 'solved_by');
    // Newer challenges nothing is known about.
    const fresh: string[] = [];
    for (let i = 2; i < 7; i++) {
      now = 2000 + i;
      fresh.push(s.lessons.recordChallenge(challenge(failureOf(i))).id);
    }
    const ids = new Set(s.lessons.nodes('project').map((n) => n.id));
    // 9 nodes were recorded against a cap of 6.
    expect(ids.size).toBeLessThanOrEqual(6);
    expect(ids.has(old.id) && ids.has(fix.id)).toBe(true);
    expect(ids.has(fresh.at(-1)!)).toBe(true);
    // Oldest of the equally useless went first.
    expect(ids.has(fresh[0]!)).toBe(false);
    for (const edge of s.lessons.edges('project')) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
    expectConsistent();
    // The survivor is still found; a pruned node is gone.
    expect(
      s.lessons.find('project', { query: failureOf(0) })[0]!.solutions,
    ).toHaveLength(1);
    expect(() => s.lessons.get('project', fresh[0]!)).toThrow('NOT_FOUND');
  });

  it('prunes by usefulness before age', () => {
    const s = openCapped(4);
    // Old and useful, then newer and useless.
    const old = s.lessons.recordChallenge(challenge(failureOf(0)));
    const fix = s.lessons.recordSolution(solution('Added the module'));
    s.lessons.link('project', old.id, fix.id, 'solved_by');
    for (let i = 1; i < 4; i++) {
      now = 1000 + i;
      s.lessons.recordChallenge(challenge(failureOf(i)));
    }
    now = 9000;
    const newest = s.lessons.recordChallenge(challenge(failureOf(4)));
    const ids = s.lessons.nodes('project').map((n) => n.id);
    expect(ids).toContain(old.id);
    expect(ids).toContain(fix.id);
    expect(ids).toContain(newest.id);
    expect(ids.length).toBeLessThanOrEqual(4);
    expectConsistent();
  });

  it('never prunes the node just written, even when it is the least useful', () => {
    const s = openCapped(1);
    const first = s.lessons.recordChallenge(challenge(failureOf(0)));
    now = 1;
    const second = s.lessons.recordChallenge(challenge(failureOf(1)));
    const ids = s.lessons.nodes('project').map((n) => n.id);
    expect(ids).toEqual([second.id]);
    expect(ids).not.toContain(first.id);
    // A solution just written survives against an older, better one too.
    const better = s.lessons.recordSolution(solution('Better'));
    expect(s.lessons.nodes('project').map((n) => n.id)).toEqual([better.id]);
    const newest = s.lessons.recordSolution(
      solution('Newest', { diff: 'n', checks: [] }),
    );
    expect(s.lessons.nodes('project').map((n) => n.id)).toEqual([newest.id]);
    expectConsistent();
  });

  it('keeps forgotten nodes out of the count and out of the pruning', () => {
    const s = openCapped(3);
    const forgotten = [0, 1].map((i) => {
      const node = s.lessons.recordChallenge(challenge(failureOf(i)));
      s.lessons.forget('project', node.id, 'noise');
      return node.id;
    });
    for (let i = 2; i < 5; i++) {
      now = 100 + i;
      s.lessons.recordChallenge(challenge(failureOf(i)));
    }
    // 2 forgotten + 3 live: the forgotten ones do not fill the cap of 3.
    expect(s.lessons.nodes('project')).toHaveLength(5);
    now = 200;
    s.lessons.recordChallenge(challenge(failureOf(5)));
    const nodes = s.lessons.nodes('project');
    expect(nodes.filter((n) => !n.forgotten)).toHaveLength(3);
    expect(nodes.filter((n) => n.forgotten).map((n) => n.id)).toEqual(
      forgotten,
    );
    expectConsistent();
  });

  it('is per scope and rejects a cap that is not a positive integer', () => {
    const s = openCapped(2);
    for (let i = 0; i < 4; i++)
      s.lessons.recordChallenge(challenge(failureOf(i), { projectId: 'a' }));
    s.lessons.recordChallenge(challenge(failureOf(0), { projectId: 'b' }));
    expect(s.lessons.nodes('a')).toHaveLength(2);
    expect(s.lessons.nodes('b')).toHaveLength(1);
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(
        () =>
          new Store(join(root, 'bad.sqlite'), {
            owner: 'bad',
            lessonCap: bad,
          }),
      ).toThrow('INVALID_INPUT');
  });
});

describe('lesson stats of stored runs', () => {
  const run = (id: string, lessons: unknown) =>
    store.graphs.create(id, 'cli', { phase: 'ready', nodes: {}, lessons }, {});
  const stats = (scope: string | undefined, extra = {}) => ({
    challenges: 1,
    solutions: 1,
    hinted: 0,
    errors: 0,
    ...(scope ? { scope } : {}),
    ...extra,
  });

  it('lists the newest runs of one scope without loading the others', () => {
    run('r1', stats('repo_a'));
    run('r2', stats('repo_b'));
    run(
      'r3',
      stats('repo_a', { repairs: { hinted: { passed: 1, failed: 0 } } }),
    );
    // Runs stored before scopes were recorded, and runs without lessons.
    run('legacy', stats(undefined));
    run('bare', undefined);
    const rows = store.graphs.lessonSummaries('repo_a');
    expect(rows.map((r) => r.id)).toEqual(['r3', 'r1']);
    expect(store.graphs.lessonSummaries('repo_a', 1).map((r) => r.id)).toEqual([
      'r3',
    ]);
    expect(store.graphs.lessonSummaries('repo_c')).toEqual([]);
    expect(() => store.graphs.lessonSummaries('repo_a', 0)).toThrow(
      'INVALID_INPUT',
    );
  });
});
