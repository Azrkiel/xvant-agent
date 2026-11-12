# A05 — Persistent project manager and bounded delegation

Status: planned. Completion prerequisite: A04. Read [the overall plan](README.md) first.

## Outcome

XVANT pursues a multi-milestone objective over time, selects useful next work, delegates to bounded subagents, learns from results, and knows when to stop. The manager reasons about proposals; the host remains authoritative for admission, task status, and acceptance.

Inspect `packages/core/src/plan.ts`, `router.ts`, the orchestrator/turn runners, context packets, and the existing project/lesson scope code. Preserve bounded DAG validation and explainable routing. The manager must not depend on a single everlasting model session.

## Execution

1. Persist projects, milestones, requirement IDs, backlog items, dependencies, priority rationale, decisions, blockers, and plan revisions. Link each delivered artifact to the requirements it is intended to satisfy.
2. Build a manager input snapshot from durable state, current repository facts, relevant accepted memory, and recent results. Tag provenance and freshness; omit unrelated transcripts.
3. Implement the manager cycle: observe, propose next work/replan, validate, admit, delegate, evaluate results, update backlog, then continue or wait. Trigger it from meaningful events and durable timers.
4. Define roles for investigation, implementation, validation, and review. Support a single-worker plan when coordination offers no benefit. Child-task proposals must pass host admission and share bounded parent authority/budgets.
5. Make plan revision explicit: preserve prior revisions, record rationale, classify changed requirements, cancel/supersede obsolete queued work, and invalidate affected downstream evidence. Never erase already committed outcomes.
6. Detect repeated failures and lack of progress using measurable signals, not worker confidence. Bound repair/replan attempts; escalate with a minimal actionable question when genuinely required.
7. Decide project completion from requirement evidence and policy. Once complete, wait for new authorized objectives/events instead of inventing endless improvements.

## Success criteria

- **A05-C1:** A project with at least three dependent milestones and a parallel opportunity completes with requirement-to-evidence traceability.
- **A05-C2:** Restarting or replacing the manager's model session loses no goal, decision, budget, or pending work.
- **A05-C3:** A genuine blocker produces a versioned replan; unrelated scope expansion is refused or separately proposed.
- **A05-C4:** A worker cannot recursively spawn unlimited tasks, expand permissions, or reset repair budgets.
- **A05-C5:** Failed verification drives bounded repair; repeated nonprogress ends in an actionable block.
- **A05-C6:** Completion and idle states produce no unnecessary model turns.
- **A05-C7:** Explicit-assignment, tier, review-independence, and account-block rules remain enforced by the host.

## Validation and latitude

Use a deterministic synthetic manager/worker campaign for reproducible edge cases, then a bounded live project once A06/A07 are qualified. Include changed requirements, an invalid plan, a dependency failure, and exhausted resources. Fixture success does not complete the live reference demonstration.

Choose planning heuristics, role composition, prompt format, and compact project summaries. Creative task decomposition is encouraged. Avoid rewarding task count, token use, or apparent activity as progress. Do not turn a reviewer's approval into sole proof of objective satisfaction.

## Deliverables and handoff

Manager loop, backlog/decision schemas, plan-revision operations, routing explanations, and project demonstration evidence. A08 supplies external wake-ups; A09 improves knowledge retrieval without becoming execution authority.
