import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { idSchema } from '../../contracts/src/index.ts';
import {
  challengeInputSchema,
  lessonRelationSchema,
  lessonSearchSchema,
  solutionInputSchema,
} from '../../contracts/src/lessons.ts';
import type {
  ChallengeInput,
  ChallengeNode,
  LessonEdge,
  LessonMatch,
  LessonNode,
  LessonRelation,
  LessonSearch,
  RankedSolution,
  SolutionInput,
  SolutionNode,
} from '../../contracts/src/lessons.ts';
import { redactSecrets } from '../../context/src/secrets.ts';
import {
  challengeOverlap,
  failureLines,
  failureSignature,
  lessonTokens,
} from '../../memory/src/lessons.ts';

export const lessonMigration = `
CREATE TABLE lesson_nodes(project_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project_id, id));
CREATE TABLE lesson_edges(project_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL, count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY(project_id, from_id, to_id, relation));
CREATE INDEX lesson_edges_to ON lesson_edges(project_id, to_id);
CREATE VIRTUAL TABLE lesson_text USING fts5(text);
`;
interface Host {
  transaction<T>(fn: () => T): T;
  now(): number;
}
interface EdgeRow {
  project_id: string;
  from_id: string;
  to_id: string;
  relation: LessonRelation;
  count: number;
  first_at: number;
  last_at: number;
}
function fail(code: string): never {
  throw new Error(code);
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) + '\n[truncated]' : text;
const edgeOf = (row: EdgeRow): LessonEdge => ({
  projectId: row.project_id,
  from: row.from_id,
  to: row.to_id,
  relation: row.relation,
  count: row.count,
  firstAt: row.first_at,
  lastAt: row.last_at,
});
/** Bounded text from untrusted output, with credential shapes removed. */
const clean = (text: string, max: number) => clip(redactSecrets(text), max);
const SEEN_IN = 5;
/** Below this share of a challenge's identifying words, a match is noise. */
const MIN_OVERLAP = 0.5;

/** Id of the challenge a failure text names; equal for the same failure. */
export function challengeId(failure: string): string {
  return 'ch_' + sha(failureSignature(failure)).slice(0, 16);
}

/**
 * The project's challenge/solution graph. Nodes are challenges and the
 * solutions tried against them; edges say which solutions worked, which did
 * not, and which challenge led to another. Writes run in the Store's fenced
 * transaction. Reads are scoped to one project.
 */
export class LessonGraph {
  readonly #db: Database.Database;
  readonly #host: Host;
  constructor(db: Database.Database, host: Host) {
    this.#db = db;
    this.#host = host;
  }
  #load(projectId: string, id: string): LessonNode | undefined {
    const row = this.#db
      .prepare('SELECT body FROM lesson_nodes WHERE project_id=? AND id=?')
      .get(projectId, id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as LessonNode) : undefined;
  }
  /** Inserts or replaces a node and keeps its search text current. */
  #put(node: LessonNode, text?: string): void {
    const existing = this.#db
      .prepare('SELECT rowid FROM lesson_nodes WHERE project_id=? AND id=?')
      .get(node.projectId, node.id) as { rowid: number } | undefined;
    if (existing)
      this.#db
        .prepare('UPDATE lesson_nodes SET body=? WHERE rowid=?')
        .run(JSON.stringify(node), existing.rowid);
    const rowid = existing
      ? existing.rowid
      : Number(
          this.#db
            .prepare('INSERT INTO lesson_nodes VALUES(?,?,?,?)')
            .run(node.projectId, node.id, node.kind, JSON.stringify(node))
            .lastInsertRowid,
        );
    if (text === undefined) return;
    this.#db.prepare('DELETE FROM lesson_text WHERE rowid=?').run(rowid);
    this.#db
      .prepare('INSERT INTO lesson_text(rowid, text) VALUES(?,?)')
      .run(rowid, text);
  }
  get(projectId: string, id: string): LessonNode {
    return (
      this.#load(idSchema.parse(projectId), String(id)) ?? fail('NOT_FOUND')
    );
  }
  /** Records one occurrence of a challenge; the same failure updates one node. */
  recordChallenge(input: ChallengeInput): ChallengeNode {
    const value = challengeInputSchema.parse(input);
    const failure = redactSecrets(value.failure);
    const id = challengeId(failure);
    const now = this.#host.now();
    return this.#host.transaction(() => {
      const prior = this.#load(value.projectId, id);
      if (prior && prior.kind !== 'challenge') fail('CONFLICT');
      const files = [
        ...new Set([...(prior?.files ?? []), ...(value.files ?? [])]),
      ].slice(0, 64);
      const context = value.context
        ? clean(value.context, 2000)
        : prior?.context;
      const node: ChallengeNode = {
        kind: 'challenge',
        id,
        projectId: value.projectId,
        signature: failureSignature(failure),
        title: clip(failureLines(failure).join(' | '), 400),
        detail: clip(failure, 6000),
        source: value.source,
        ...(context ? { context } : {}),
        files,
        occurrences: (prior?.occurrences ?? 0) + 1,
        firstSeenAt: prior?.firstSeenAt ?? now,
        lastSeenAt: now,
        seenIn: [...(prior?.seenIn ?? []), value.provenance].slice(-SEEN_IN),
      };
      this.#put(
        node,
        [node.title, node.signature, node.context ?? '', files.join(' ')].join(
          '\n',
        ),
      );
      return node;
    });
  }
  /** Records a change made against a challenge; identical changes share a node. */
  recordSolution(input: SolutionInput): SolutionNode {
    const value = solutionInputSchema.parse(input);
    const summary = clean(value.summary, 4000);
    const diff = clean(value.diff, 6000);
    const id =
      'sol_' +
      sha(
        JSON.stringify([
          value.projectId,
          [...value.files].sort(),
          sha(value.diff),
          summary,
        ]),
      ).slice(0, 16);
    const now = this.#host.now();
    return this.#host.transaction(() => {
      const prior = this.#load(value.projectId, id);
      if (prior && prior.kind !== 'solution') fail('CONFLICT');
      const node: SolutionNode = prior
        ? {
            ...prior,
            checks: [...new Set([...prior.checks, ...value.checks])],
          }
        : {
            kind: 'solution',
            id,
            projectId: value.projectId,
            summary,
            files: value.files,
            diff,
            checks: value.checks,
            createdAt: now,
            provenance: value.provenance,
            usage: { suggested: 0, succeeded: 0, failed: 0 },
          };
      this.#put(
        node,
        prior ? undefined : summary + '\n' + value.files.join(' '),
      );
      return node;
    });
  }
  /** Adds an edge, or counts one more observation of it. */
  link(
    projectId: string,
    from: string,
    to: string,
    relation: LessonRelation,
  ): LessonEdge {
    idSchema.parse(projectId);
    lessonRelationSchema.parse(relation);
    const now = this.#host.now();
    return this.#host.transaction(() => {
      const a = this.#load(projectId, from) ?? fail('NOT_FOUND');
      const b = this.#load(projectId, to) ?? fail('NOT_FOUND');
      if (
        a.kind !== 'challenge' ||
        (relation === 'followed_by') !== (b.kind === 'challenge') ||
        from === to
      )
        fail('INVALID_INPUT');
      this.#db
        .prepare(
          'INSERT INTO lesson_edges VALUES(?,?,?,?,1,?,?) ON CONFLICT(project_id, from_id, to_id, relation) DO UPDATE SET count=count+1, last_at=excluded.last_at',
        )
        .run(projectId, from, to, relation, now, now);
      return edgeOf(
        this.#db
          .prepare(
            'SELECT * FROM lesson_edges WHERE project_id=? AND from_id=? AND to_id=? AND relation=?',
          )
          .get(projectId, from, to, relation) as EdgeRow,
      );
    });
  }
  /**
   * Feedback from reuse: the solutions shown to a repair, and whether that
   * repair then passed its checks. Ranking uses it, so suggestions that keep
   * failing sink and ones that keep helping rise.
   */
  recordUsage(
    projectId: string,
    solutionIds: readonly string[],
    succeeded: boolean,
  ): void {
    idSchema.parse(projectId);
    this.#host.transaction(() => {
      for (const id of new Set(solutionIds)) {
        const node = this.#load(projectId, id);
        if (node?.kind !== 'solution') continue;
        this.#put({
          ...node,
          usage: {
            suggested: node.usage.suggested + 1,
            succeeded: node.usage.succeeded + (succeeded ? 1 : 0),
            failed: node.usage.failed + (succeeded ? 0 : 1),
          },
        });
      }
    });
  }
  nodes(projectId: string): LessonNode[] {
    return (
      this.#db
        .prepare(
          'SELECT body FROM lesson_nodes WHERE project_id=? ORDER BY rowid',
        )
        .all(idSchema.parse(projectId)) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as LessonNode);
  }
  edges(projectId: string, from?: string): LessonEdge[] {
    const rows = (
      from === undefined
        ? this.#db
            .prepare(
              'SELECT * FROM lesson_edges WHERE project_id=? ORDER BY rowid',
            )
            .all(idSchema.parse(projectId))
        : this.#db
            .prepare(
              'SELECT * FROM lesson_edges WHERE project_id=? AND from_id=? ORDER BY rowid',
            )
            .all(idSchema.parse(projectId), from)
    ) as EdgeRow[];
    return rows.map(edgeOf);
  }
  /** Ranks a challenge's solutions: verified, repeatedly working and helpful first. */
  #solutions(projectId: string, challenge: ChallengeNode) {
    const solutions: RankedSolution[] = [];
    const deadEnds: LessonMatch['deadEnds'] = [];
    for (const edge of this.edges(projectId, challenge.id)) {
      const node = this.#load(projectId, edge.to);
      if (node?.kind !== 'solution') continue;
      if (edge.relation === 'not_solved_by') {
        deadEnds.push({ solution: node, edge });
        continue;
      }
      if (edge.relation !== 'solved_by') continue;
      const wins = edge.count + node.usage.succeeded;
      const score =
        ((wins + 1) / (wins + node.usage.failed + 2)) *
        (node.checks.length ? 1 : 0.5);
      solutions.push({ solution: node, edge, score });
    }
    solutions.sort(
      (a, b) => b.score - a.score || b.edge.lastAt - a.edge.lastAt,
    );
    deadEnds.sort((a, b) => b.edge.count - a.edge.count);
    return { solutions: solutions.slice(0, 3), deadEnds: deadEnds.slice(0, 3) };
  }
  /**
   * Known challenges that match a failure or a description of one: the exact
   * same failure first, then challenges whose identifying words the query
   * contains. Only challenges with something learned (a solution or a dead
   * end) are returned.
   */
  find(projectId: string, search: LessonSearch): LessonMatch[] {
    idSchema.parse(projectId);
    const { query, limit = 3 } = lessonSearchSchema.parse(search);
    const exactId = challengeId(query);
    const candidates = new Map<string, ChallengeNode>();
    const exact = this.#load(projectId, exactId);
    if (exact?.kind === 'challenge') candidates.set(exact.id, exact);
    const words = lessonTokens(failureLines(query).join(' ') + ' ' + query)
      .slice(0, 48)
      .map((word) => '"' + word.replace(/"/g, '') + '"');
    if (words.length) {
      const rows = this.#db
        .prepare(
          "SELECT n.body FROM lesson_text t JOIN lesson_nodes n ON n.rowid = t.rowid WHERE lesson_text MATCH ? AND n.project_id = ? AND n.kind = 'challenge' ORDER BY bm25(lesson_text) LIMIT 30",
        )
        .all(words.join(' OR '), projectId) as { body: string }[];
      for (const row of rows) {
        const node = JSON.parse(row.body) as ChallengeNode;
        if (challengeOverlap(query, node.signature) >= MIN_OVERLAP)
          candidates.set(node.id, node);
      }
    }
    const matches: LessonMatch[] = [];
    for (const challenge of candidates.values()) {
      const found = this.#solutions(projectId, challenge);
      if (!found.solutions.length && !found.deadEnds.length) continue;
      matches.push({ challenge, exact: challenge.id === exactId, ...found });
    }
    matches.sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        challengeOverlap(query, b.challenge.signature) -
          challengeOverlap(query, a.challenge.signature) ||
        b.challenge.lastSeenAt - a.challenge.lastSeenAt,
    );
    return matches.slice(0, limit);
  }
}
