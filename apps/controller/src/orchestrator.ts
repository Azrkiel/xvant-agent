import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { WorkerSupervisor } from '../../../packages/supervisor/src/index.ts';
import type { Store } from '../../../packages/storage/src/store.ts';
import { createWorktree } from '../../../packages/storage/src/git-workspace.ts';
import { IntegrationBranch } from '../../../packages/storage/src/integration.ts';
import {
  extractJson,
  planningPrompt,
  validatePlan,
  type Plan,
  type PlanInput,
  type PlanNode,
} from '../../../packages/core/src/plan.ts';
import {
  routeNode,
  type RouteDecision,
} from '../../../packages/core/src/router.ts';
import { RunLessons, type LessonStats } from './lessons.ts';

export interface Check {
  executable: string;
  args: readonly string[];
}
export interface WorkerSpec {
  alias: string;
  runtimeKind: 'codex' | 'claude' | 'opencode' | 'native-local';
  quotaGroupId: string;
  roles: readonly ('worker' | 'reviewer' | 'planner')[];
  /** Model for this worker's turns; absent means its runtime's model. */
  model?: string;
}
export interface TurnRequest {
  taskId: string;
  projectId: string;
  alias: string;
  prompt: string;
  workspace: { path: string; baseCommit: string };
  checks: Record<string, Check>;
  /**
   * Paths the turn may change; absent or empty means the whole worktree.
   * External runtimes get them as prompt text; XVANT's own tools enforce them.
   */
  writablePaths?: string[];
}
export interface TurnOutcome {
  status:
    'accepted' | 'verification_failed' | 'failed' | 'cancelled' | 'unknown';
  finalText: string;
  patch: Buffer | null;
  files: string[];
  failure?: string;
}
/** Runs one worker turn and returns the host-verified outcome. */
export interface TurnRunner {
  run(request: TurnRequest): Promise<TurnOutcome>;
  interrupt(taskId: string): boolean;
}
export interface RootSpec {
  id: string;
  projectId: string;
  repository: string;
  baseRevision: string;
  objective: string;
  acceptanceCriteria: string[];
  /** Registered commands the combined result must pass. */
  checks: Record<string, Check>;
  /** Which of `checks` each node must also pass in its own worktree. */
  nodeChecks?: string[];
  /** A plan given up front skips the planning turn. */
  plan?: PlanInput;
  maxActive?: number;
  maxRepairs?: number;
  review?: boolean;
  /** Repair rounds a rejecting review may start before the result is handed over as it is. */
  maxReviewRepairs?: number;
  checkTimeoutMs?: number;
  /**
   * Record challenges and the fixes that resolved them in the project's
   * lesson graph, and show known fixes to repairs. On unless false.
   */
  lessons?: boolean;
}
type NodeStatus =
  'pending' | 'running' | 'integrated' | 'failed' | 'needs_attention';
interface NodeState {
  node: PlanNode;
  status: NodeStatus;
  repairs: number;
  attempts: {
    taskId: string;
    alias: string;
    status: string;
    files: string[];
    failure?: string;
  }[];
  notes: string[];
  lastFailure?: string;
  /** The lesson-graph challenge the next attempt is repairing. */
  challenge?: string;
  /** Solutions the graph showed to the attempt now running. */
  suggested?: string[];
  route?: RouteDecision;
}
export type RootPhase =
  | 'planning'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'ready'
  | 'accepted'
  | 'failed'
  | 'needs_attention'
  | 'cancelled';
export interface RootState {
  phase: RootPhase;
  /** The user's repository; its checkout is never changed. */
  repository?: string;
  objective: string;
  acceptanceCriteria: string[];
  plan: Plan | null;
  nodes: Record<string, NodeState>;
  integration: {
    branch: string;
    path: string;
    baseCommit: string;
    head: string;
  } | null;
  checks: { id: string; status: 'passed' | 'failed'; head: string }[];
  review: {
    alias: string;
    approve: boolean;
    findings: string[];
    /** Whether the reviewer implemented none of the reviewed work. */
    independent: boolean;
    /** Whether an implementer used the reviewer's runtime (a weaker check). */
    sameRuntime: boolean;
  } | null;
  /** Repair rounds started by a rejecting review. */
  reviewRepairs?: number;
  /** What this run recorded in, and used from, the lesson graph. */
  lessons?: LessonStats;
  reason?: string;
}
const tail = (text: string, max = 3000) =>
  text.length > max ? '…' + text.slice(-max) : text;
// The first line names the failure; check output below it varies run to run.
const signature = (text: string) =>
  createHash('sha256')
    .update(text.split('\n', 1)[0]!)
    .digest('hex')
    .slice(0, 16);

/**
 * Coordinates one root task across named workers: plan, route, run nodes in
 * isolated worktrees, integrate accepted patches one at a time, verify the
 * combined revision, review it on an independent runtime and stop at
 * `ready` for the user's acceptance. Known failures get bounded repairs;
 * unknown outcomes are never retried automatically.
 */
export class Orchestrator {
  readonly #store: Store;
  readonly #runner: TurnRunner;
  readonly #workers: WorkerSpec[];
  readonly #root: string;
  readonly #supervisor = new WorkerSupervisor();
  readonly #onChange: (state: RootState, kind: string) => void;
  #cancelled = false;
  readonly #running = new Map<string, string>();
  constructor(
    store: Store,
    runner: TurnRunner,
    workers: WorkerSpec[],
    options: {
      stateRoot: string;
      onChange?: (state: RootState, kind: string) => void;
    },
  ) {
    const aliases = new Set(workers.map((w) => w.alias.toLowerCase()));
    if (aliases.size !== workers.length) throw new Error('DUPLICATE_IDENTITY');
    this.#store = store;
    this.#runner = runner;
    this.#workers = workers;
    this.#root = options.stateRoot;
    this.#onChange = options.onChange ?? (() => {});
  }
  cancel(): void {
    this.#cancelled = true;
    for (const taskId of this.#running.keys()) this.#runner.interrupt(taskId);
  }
  async run(spec: RootSpec): Promise<RootState> {
    // Turn controllers renew the store lease only while a turn runs. Checks
    // and integration run between turns and can outlast the lease.
    const renew = () => {
      try {
        this.#store.heartbeat();
      } catch {
        /* A lost lease fails the next write, which reports it. */
      }
    };
    // Once now: a run shorter than the interval would otherwise never renew.
    renew();
    const beat = setInterval(renew, this.#store.heartbeatIntervalMs);
    try {
      return await this.#run(spec);
    } finally {
      clearInterval(beat);
    }
  }
  async #run(spec: RootSpec): Promise<RootState> {
    const maxActive = spec.maxActive ?? 3;
    const maxRepairs = spec.maxRepairs ?? 2;
    const state: RootState = {
      phase: 'planning',
      repository: spec.repository,
      objective: spec.objective,
      acceptanceCriteria: spec.acceptanceCriteria,
      plan: null,
      nodes: {},
      integration: null,
      checks: [],
      review: null,
    };
    const lessons = new RunLessons(
      spec.lessons === false ? null : this.#store,
      spec.projectId,
      spec.id,
    );
    state.lessons = lessons.stats;
    const changeOf = (
      outcome: TurnOutcome,
      taskId: string,
      alias: string,
      checks: string[],
    ) => ({
      summary: outcome.finalText,
      files: outcome.files,
      diff: outcome.patch?.toString('utf8') ?? '',
      checks,
      taskId,
      alias,
    });
    let record = this.#store.graphs.create(spec.id, spec.projectId, state, {
      objective: spec.objective,
    });
    const save = (kind: string, payload: unknown = {}) => {
      record = this.#store.graphs.update(
        spec.id,
        record.rowVersion,
        state,
        kind,
        payload,
      );
      this.#onChange(structuredClone(state), kind);
    };
    const integration = IntegrationBranch.create(
      spec.repository,
      spec.baseRevision,
      join(this.#root, spec.id, 'integration'),
      'xvant/' + spec.id,
    );
    state.integration = {
      branch: integration.branch,
      path: integration.path,
      baseCommit: integration.baseCommit,
      head: integration.head(),
    };
    let turnCount = 0;
    const turnId = (label: string) => spec.id + '-' + label + '-' + ++turnCount;
    const busy = new Set<string>();
    const completed = new Map<string, string[]>();
    const worktree = (label: string) =>
      createWorktree(
        spec.repository,
        integration.head(),
        join(this.#root, spec.id, 'wt', label),
        // Separate namespace: a branch cannot nest under the integration branch.
        'xvant-work/' + spec.id + '/' + label,
      );
    const noop = { reply: { executable: process.execPath, args: ['-e', ''] } };
    const turn = async (
      alias: string,
      label: string,
      prompt: string,
      checks: Record<string, Check>,
      writablePaths: string[] = [],
    ) => {
      const taskId = turnId(label);
      const tree = worktree(taskId);
      busy.add(alias);
      this.#running.set(taskId, alias);
      try {
        const outcome = await this.#runner.run({
          taskId,
          projectId: spec.projectId,
          alias,
          prompt,
          workspace: tree,
          checks: Object.keys(checks).length ? checks : noop,
          ...(writablePaths.length ? { writablePaths } : {}),
        });
        return { taskId, outcome };
      } finally {
        busy.delete(alias);
        this.#running.delete(taskId);
      }
    };
    const routable = () =>
      this.#workers.map((w) => ({
        alias: w.alias,
        runtimeKind: w.runtimeKind,
        quotaGroupId: w.quotaGroupId,
        busy: busy.has(w.alias),
        healthy: true,
        blocked: !!this.#store.providers.blocked(w.quotaGroupId),
        completed: completed.get(w.alias) ?? [],
        roles: w.roles.filter(
          (r): r is 'worker' | 'reviewer' => r !== 'planner',
        ),
      }));
    try {
      // 1. Plan.
      if (spec.plan) state.plan = validatePlan(spec.plan).plan;
      else {
        const planner =
          this.#workers.find((w) => w.roles.includes('planner')) ??
          this.#workers[0];
        if (!planner) throw new Error('NO_WORKERS');
        let feedback = '';
        for (let tries = 0; tries < 2 && !state.plan; tries++) {
          const { outcome } = await turn(
            planner.alias,
            'plan',
            planningPrompt({
              objective: spec.objective,
              acceptanceCriteria: spec.acceptanceCriteria,
              workers: this.#workers,
              repositorySummary: 'Base revision ' + integration.baseCommit,
              maxNodes: 20,
            }) + feedback,
            {},
          );
          if (outcome.status === 'unknown') throw new Error('PLANNER_UNKNOWN');
          try {
            state.plan = validatePlan(extractJson(outcome.finalText)).plan;
          } catch (error) {
            // The reply itself is not kept, so the reason is the only trace of it.
            save('graph.plan_rejected', {
              tries: tries + 1,
              reason: (error as Error).message,
            });
            feedback =
              '\n\nYour previous plan was rejected: ' +
              (error as Error).message +
              '. Reply again with a corrected json block.';
          }
        }
        if (!state.plan) throw new Error('PLAN_INVALID');
      }
      for (const node of state.plan.nodes)
        state.nodes[node.id] = {
          node,
          status: 'pending',
          repairs: 0,
          attempts: [],
          notes: [],
        };
      state.phase = 'running';
      save('graph.planned', { nodes: state.plan.nodes.map((n) => n.id) });

      // 2. Run nodes and integrate.
      const nodeChecks = Object.fromEntries(
        (spec.nodeChecks ?? []).map((id) => [id, spec.checks[id]!]),
      );
      const inflight = new Map<string, Promise<void>>();
      const implementers = new Set<string>();
      const settleNode = async (
        id: string,
        alias: string,
        taskId: string,
        outcome: TurnOutcome,
      ) => {
        const entry = state.nodes[id]!;
        entry.attempts.push({
          taskId,
          alias,
          status: outcome.status,
          files: outcome.files,
          ...(outcome.failure ? { failure: outcome.failure } : {}),
        });
        if (outcome.status === 'accepted') {
          const applied = integration.apply(
            outcome.patch ?? Buffer.alloc(0),
            'xvant: ' + id + ' by ' + alias + '\n\n' + entry.node.title,
          );
          if (applied.status === 'conflict') {
            entry.lastFailure =
              'Integration conflict in ' + applied.files.join(', ');
          } else {
            entry.status = 'integrated';
            implementers.add(
              this.#workers.find((w) => w.alias === alias)!.runtimeKind,
            );
            completed.set(alias, [...(completed.get(alias) ?? []), id]);
            state.integration!.head = integration.head();
            if (applied.status === 'empty')
              entry.notes.push('Accepted with no changes');
            // The node's checks passed on this change: it solved the failure
            // the attempt was repairing.
            if (entry.challenge)
              lessons.resolve(
                [entry.challenge],
                'solved_by',
                changeOf(outcome, taskId, alias, Object.keys(nodeChecks)),
              );
            lessons.usage(entry.suggested, true);
            delete entry.challenge;
            delete entry.suggested;
            save('node.integrated', {
              id,
              alias,
              head: state.integration!.head,
            });
            return;
          }
        } else if (
          outcome.status === 'unknown' ||
          outcome.status === 'cancelled'
        ) {
          entry.status = 'needs_attention';
          save('node.needs_attention', { id, alias, status: outcome.status });
          return;
        } else entry.lastFailure = outcome.failure ?? outcome.status;
        // Check failures and conflicts are challenges about the code; a
        // runtime that failed to work says nothing about how to fix it.
        if (outcome.status !== 'failed') {
          const previous = entry.challenge;
          const current = lessons.challenge({
            failure: entry.lastFailure,
            source: 'node',
            context: entry.node.title + '\n' + entry.node.objective,
            files: outcome.files,
            taskId,
          });
          if (previous && previous === current)
            lessons.resolve(
              [previous],
              'not_solved_by',
              changeOf(outcome, taskId, alias, []),
            );
          else lessons.followedBy(previous, current);
          lessons.usage(entry.suggested, false);
          if (current) entry.challenge = current;
          else delete entry.challenge;
          delete entry.suggested;
        }
        const repeated =
          entry.attempts.length >= 2 &&
          signature(
            entry.attempts.at(-2)!.failure ?? entry.attempts.at(-2)!.status,
          ) === signature(entry.lastFailure);
        if (entry.repairs >= maxRepairs || repeated) {
          entry.status = 'failed';
          save('node.failed', { id, reason: entry.lastFailure, repeated });
        } else {
          entry.repairs++;
          entry.status = 'pending';
          save('node.repair', {
            id,
            repairs: entry.repairs,
            reason: entry.lastFailure,
          });
        }
      };
      const nodePrompt = (entry: NodeState) => {
        const deps = entry.node.dependsOn.map((d) => state.nodes[d]!);
        const hint = entry.lastFailure
          ? lessons.hints(entry.lastFailure + '\n' + entry.node.title)
          : { text: '', suggested: [] };
        if (hint.suggested.length) entry.suggested = hint.suggested;
        else delete entry.suggested;
        return [
          'You are working on part of a larger XVANT task.',
          '',
          '## Overall objective',
          spec.objective,
          '',
          '## Your task: ' + entry.node.title,
          entry.node.objective,
          '',
          '## Acceptance criteria',
          ...entry.node.acceptanceCriteria.map((c) => '- ' + c),
          ...(entry.node.writablePaths.length
            ? ['', 'Only change: ' + entry.node.writablePaths.join(', ')]
            : []),
          ...(deps.length
            ? [
                '',
                '## Already done (in your working copy)',
                ...deps.map((d) => '- ' + d.node.title),
              ]
            : []),
          ...(entry.lastFailure
            ? [
                '',
                '## Previous attempt failed',
                tail(entry.lastFailure, 9000),
                'Fix the cause before finishing.',
              ]
            : []),
          ...(hint.text ? ['', hint.text] : []),
          '',
          'Work only in the current directory. Do not commit. Finish with a short summary.',
        ].join('\n');
      };
      for (;;) {
        if (this.#cancelled) throw new Error('CANCELLED');
        const entries = Object.values(state.nodes);
        if (
          entries.some(
            (e) => e.status === 'failed' || e.status === 'needs_attention',
          ) &&
          !inflight.size
        )
          break;
        if (entries.every((e) => e.status === 'integrated')) break;
        const blocked = entries.some(
          (e) => e.status === 'failed' || e.status === 'needs_attention',
        );
        if (!blocked)
          for (const entry of entries) {
            if (inflight.size >= maxActive) break;
            if (entry.status !== 'pending') continue;
            if (
              !entry.node.dependsOn.every(
                (d) => state.nodes[d]!.status === 'integrated',
              )
            )
              continue;
            const decision = routeNode(entry.node, routable(), {
              implementerRuntimes: [...implementers],
            });
            entry.route = decision;
            if (!decision.alias) continue;
            entry.status = 'running';
            save('node.dispatched', {
              id: entry.node.id,
              alias: decision.alias,
              reasons: decision.reasons,
            });
            const alias = decision.alias;
            const id = entry.node.id;
            inflight.set(
              id,
              turn(
                alias,
                id,
                nodePrompt(entry),
                nodeChecks,
                entry.node.writablePaths,
              )
                .then(({ taskId, outcome }) =>
                  settleNode(id, alias, taskId, outcome),
                )
                .catch((error) =>
                  settleNode(id, alias, 'none', {
                    status: 'unknown',
                    finalText: '',
                    patch: null,
                    files: [],
                    failure: (error as Error).message,
                  }),
                )
                .finally(() => inflight.delete(id)),
            );
          }
        if (!inflight.size) {
          if (Object.values(state.nodes).some((e) => e.status === 'pending'))
            throw new Error('ROUTING_STALLED');
          continue;
        }
        await Promise.race(inflight.values());
      }
      const stuck = Object.values(state.nodes).find(
        (e) => e.status === 'failed' || e.status === 'needs_attention',
      );
      if (stuck) {
        state.phase = stuck.status === 'failed' ? 'failed' : 'needs_attention';
        state.reason =
          'Node ' +
          stuck.node.id +
          ' ' +
          stuck.status +
          (stuck.lastFailure ? ': ' + tail(stuck.lastFailure, 500) : '');
        save('graph.' + state.phase, { reason: state.reason });
        return state;
      }

      const maxReviewRepairs = spec.maxReviewRepairs ?? 1;
      type Pending = {
        /** Check id or review finding -> challenge id. */
        challenges: Map<string, string>;
        change: ReturnType<typeof changeOf>;
        suggested: string[];
      };
      let pendingFix: Pending | null = null;
      let pendingReviewFix: Pending | null = null;
      let findingChallenges = new Map<string, string>();
      for (let reviewRepairs = 0; ; reviewRepairs++) {
        // 3. Verify the combined revision, repairing within the budget.
        for (let fixes = 0; ; fixes++) {
          state.phase = 'verifying';
          const head = integration.head();
          const results = await this.#runChecks(
            integration.path,
            spec.checks,
            spec.checkTimeoutMs ?? 10 * 60 * 1000,
          );
          state.checks = results.map((r) => ({
            id: r.id,
            status: r.status,
            head,
          }));
          const failing = results.filter((r) => r.status === 'failed');
          const passed = results
            .filter((r) => r.status === 'passed')
            .map((r) => r.id);
          // Judge the last fix by this run of the checks it was meant to fix.
          if (pendingFix) {
            const fix: Pending = pendingFix;
            const change = { ...fix.change, checks: passed };
            const entries = [...fix.challenges];
            const unsolved = entries
              .filter(([check]) => !passed.includes(check))
              .map(([, id]) => id);
            lessons.resolve(
              entries
                .filter(([check]) => passed.includes(check))
                .map(([, id]) => id),
              'solved_by',
              change,
            );
            lessons.resolve(unsolved, 'not_solved_by', change);
            lessons.usage(fix.suggested, !unsolved.length);
            pendingFix = null;
          }
          const failures = failing.map(
            (f) =>
              'Combined check ' + f.id + ' failed\n' + tail(f.output, 20000),
          );
          const checkChallenges = new Map<string, string>();
          failing.forEach((f, i) => {
            const id = lessons.challenge({
              failure: failures[i]!,
              source: 'checks',
              context: spec.objective,
            });
            if (id) checkChallenges.set(f.id, id);
          });
          save('graph.checked', { head, checks: state.checks });
          if (!failing.length) break;
          if (fixes >= maxRepairs) {
            state.phase = 'failed';
            state.reason =
              'Combined checks still fail: ' +
              failing.map((f) => f.id).join(', ');
            save('graph.failed', { reason: state.reason });
            return state;
          }
          const fixer = routeNode(
            { id: 'fix', role: 'worker', assignee: 'any', dependsOn: [] },
            routable(),
          );
          if (!fixer.alias) throw new Error('ROUTING_STALLED');
          const fixHint = lessons.hints(failures);
          const { taskId, outcome } = await turn(
            fixer.alias,
            'fix',
            [
              'The combined work for this objective fails its checks. Fix the code so they pass.',
              '',
              '## Objective',
              spec.objective,
              '',
              ...failing.flatMap((f) => [
                '## Failing check: ' + f.id,
                tail(f.output),
              ]),
              ...(fixHint.text ? ['', fixHint.text] : []),
              '',
              'Work only in the current directory. Do not commit.',
            ].join('\n'),
            nodeChecks,
          );
          const applied =
            outcome.status === 'accepted'
              ? integration.apply(
                  outcome.patch ?? Buffer.alloc(0),
                  'xvant: fix checks by ' + fixer.alias,
                )
              : null;
          if (applied?.status === 'applied')
            pendingFix = {
              challenges: checkChallenges,
              change: changeOf(outcome, taskId, fixer.alias, []),
              suggested: fixHint.suggested,
            };
          // An unknown outcome says nothing about whether the hints helped.
          else if (
            outcome.status !== 'unknown' &&
            outcome.status !== 'cancelled'
          )
            lessons.usage(fixHint.suggested, false);
          save('graph.fix', {
            taskId,
            alias: fixer.alias,
            status: outcome.status,
            applied: applied?.status ?? null,
          });
          if (outcome.status === 'unknown') {
            state.phase = 'needs_attention';
            state.reason = 'Fix turn ' + taskId + ' has an unknown outcome';
            save('graph.needs_attention', { reason: state.reason });
            return state;
          }
        }

        // 4. Independent review of the combined change.
        if (spec.review === false) break;
        {
          state.phase = 'reviewing';
          const reviewer = routeNode(
            { id: 'review', role: 'reviewer', assignee: 'any', dependsOn: [] },
            routable(),
            { implementerRuntimes: [...implementers] },
          );
          if (reviewer.alias) {
            const diff = integration.diff();
            const { outcome } = await turn(
              reviewer.alias,
              'review',
              [
                'Review this change against the objective and criteria. Do not change any files.',
                '',
                '## Objective',
                spec.objective,
                '',
                '## Acceptance criteria',
                ...spec.acceptanceCriteria.map((c) => '- ' + c),
                '',
                '## Change',
                '```diff',
                tail(diff, 20000),
                '```',
                '',
                'Reply with one fenced json block: {"approve": true|false, "findings": ["specific problem", ...]}. Only block approval for real defects.',
              ].join('\n'),
              {},
            );
            let verdict = {
              approve: false,
              findings: ['Reviewer reply was not a verdict'],
            };
            try {
              const parsed = extractJson(outcome.finalText) as {
                approve?: unknown;
                findings?: unknown;
              };
              if (typeof parsed.approve === 'boolean')
                verdict = {
                  approve: parsed.approve,
                  findings: Array.isArray(parsed.findings)
                    ? parsed.findings
                        .filter((f): f is string => typeof f === 'string')
                        .slice(0, 20)
                    : [],
                };
            } catch {
              /* keep the non-verdict default */
            }
            const reviewerRuntime = this.#workers.find(
              (w) => w.alias === reviewer.alias,
            )!.runtimeKind;
            state.review = {
              alias: reviewer.alias,
              ...verdict,
              independent: !(completed.get(reviewer.alias) ?? []).length,
              sameRuntime: implementers.has(reviewerRuntime),
            };
            findingChallenges = new Map();
            if (!verdict.approve)
              for (const finding of verdict.findings) {
                const id = lessons.challenge({
                  failure: finding,
                  source: 'review',
                  context: spec.objective,
                });
                if (id) findingChallenges.set(finding, id);
              }
            // Judge the last review fix: an approval solved its findings; a
            // finding raised again was not solved. Others stay undecided.
            if (pendingReviewFix) {
              const fix: Pending = pendingReviewFix;
              const raised = new Set(findingChallenges.values());
              const ids = [...fix.challenges.values()];
              const change = {
                ...fix.change,
                checks: state.checks
                  .filter((c) => c.status === 'passed')
                  .map((c) => c.id),
              };
              if (verdict.approve) lessons.resolve(ids, 'solved_by', change);
              else
                lessons.resolve(
                  ids.filter((id) => raised.has(id)),
                  'not_solved_by',
                  change,
                );
              lessons.usage(fix.suggested, verdict.approve);
              pendingReviewFix = null;
            }
            save('graph.reviewed', state.review);
          } else
            state.review = {
              alias: 'none',
              approve: false,
              findings: ['No reviewer available'],
              independent: false,
              sameRuntime: false,
            };
        }

        // 5. A review that names defects gets a bounded repair, then the
        // result is verified and reviewed again. A rejection that still stands
        // is handed over with its findings; the user decides.
        const review = state.review;
        if (
          review.approve ||
          review.alias === 'none' ||
          !review.findings.length ||
          reviewRepairs >= maxReviewRepairs
        )
          break;
        const fixer = routeNode(
          { id: 'review-fix', role: 'worker', assignee: 'any', dependsOn: [] },
          routable(),
        );
        if (!fixer.alias) break;
        state.phase = 'running';
        const reviewHint = lessons.hints(review.findings);
        const { taskId, outcome } = await turn(
          fixer.alias,
          'review-fix',
          [
            'A reviewer found defects in the combined work for this objective. Fix each one that is real; leave the rest of the work as it is.',
            '',
            '## Objective',
            spec.objective,
            '',
            '## Acceptance criteria',
            ...spec.acceptanceCriteria.map((c) => '- ' + c),
            '',
            '## Review findings',
            ...review.findings.map((f) => '- ' + f),
            ...(reviewHint.text ? ['', reviewHint.text] : []),
            '',
            'Work only in the current directory. Do not commit. Finish with a short summary.',
          ].join('\n'),
          nodeChecks,
        );
        const applied =
          outcome.status === 'accepted'
            ? integration.apply(
                outcome.patch ?? Buffer.alloc(0),
                'xvant: fix review findings by ' + fixer.alias,
              )
            : null;
        state.reviewRepairs = reviewRepairs + 1;
        if (applied?.status === 'applied')
          pendingReviewFix = {
            challenges: findingChallenges,
            change: changeOf(outcome, taskId, fixer.alias, []),
            suggested: reviewHint.suggested,
          };
        else if (outcome.status !== 'unknown' && outcome.status !== 'cancelled')
          lessons.usage(reviewHint.suggested, false);
        save('graph.review_fix', {
          taskId,
          alias: fixer.alias,
          status: outcome.status,
          applied: applied?.status ?? null,
        });
        if (outcome.status === 'unknown') {
          state.phase = 'needs_attention';
          state.reason =
            'Review fix turn ' + taskId + ' has an unknown outcome';
          save('graph.needs_attention', { reason: state.reason });
          return state;
        }
        // Nothing changed: the rejection stands as reviewed.
        if (applied?.status !== 'applied') break;
        state.integration!.head = integration.head();
        // The fixer now wrote part of the result, which a later review must know.
        completed.set(fixer.alias, [
          ...(completed.get(fixer.alias) ?? []),
          'review-fix',
        ]);
        implementers.add(
          this.#workers.find((w) => w.alias === fixer.alias)!.runtimeKind,
        );
      }
      state.phase = 'ready';
      save('graph.ready', {
        head: integration.head(),
        branch: integration.branch,
      });
      return state;
    } catch (error) {
      state.phase = this.#cancelled ? 'cancelled' : 'needs_attention';
      state.reason = (error as Error).message;
      try {
        save('graph.' + state.phase, { reason: state.reason });
      } catch {
        /* the store may be gone */
      }
      return state;
    }
  }
  async #runChecks(
    cwd: string,
    checks: Record<string, Check>,
    timeoutMs: number,
  ) {
    const results: {
      id: string;
      status: 'passed' | 'failed';
      output: string;
    }[] = [];
    for (const [id, check] of Object.entries(checks)) {
      const result = await this.#supervisor.start({
        ...check,
        cwd,
        workerId: 'integration_checks',
        attemptId: 'combined',
        generation: 1,
        timeoutMs,
        maxOutputBytes: 1048576,
        userApprovedTrustedLocal: true,
      }).result;
      results.push({
        id,
        status:
          result.reason === 'exited' && result.exitCode === 0
            ? 'passed'
            : 'failed',
        output: result.stdout + result.stderr,
      });
    }
    return results;
  }
}
