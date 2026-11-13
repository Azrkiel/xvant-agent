# A05 — Persistent project manager

Status: planned. Completion prerequisites: **A04**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

XVANT completes an objective through several milestones, revises its plan when needed, and delegates bounded work without depending on one long model conversation.

## Start here

Inspect `packages/core/src/plan.ts`, `packages/core/src/router.ts`, `apps/controller/src/orchestrator.ts`, `apps/controller/src/turn-runner.ts`, `packages/context`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Add a persistent backlog. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Add a persistent backlog

Store milestones, requirement links, priorities and rationale, dependencies, decisions, questions, blockers, and plan revisions. Create a compact manager snapshot from current durable facts.

**Deliver:** A project record and inspectable backlog that survives session replacement.

### Work package 2: Implement the manager cycle

Observe results/events, propose the next bounded plan, validate host admission, delegate roles, evaluate results, and update the backlog. Support investigation and a single-worker route as well as parallel implementation.

**Deliver:** A deterministic multi-milestone fixture with routing explanations.

### Work package 3: Handle change and stop correctly

Version replans, supersede obsolete work, invalidate affected downstream evidence, bound repairs/child tasks, detect nonprogress, and become idle when requirements are satisfied.

**Deliver:** A restart/replan demonstration and an actionable blocker path.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A05-C1:** A project with at least three dependent milestones and a parallel opportunity completes with requirement-to-evidence traceability.
- [ ] **A05-C2:** Restarting or replacing the manager's model session loses no goal, decision, budget, or pending work.
- [ ] **A05-C3:** A genuine blocker produces a versioned replan; unrelated scope expansion is refused or separately proposed.
- [ ] **A05-C4:** A worker cannot recursively spawn unlimited tasks, expand permissions, or reset repair budgets.
- [ ] **A05-C5:** Failed verification drives bounded repair; repeated nonprogress ends in an actionable block.
- [ ] **A05-C6:** Completion and idle states produce no unnecessary model turns.
- [ ] **A05-C7:** Explicit-assignment, tier, review-independence, and account-block rules remain enforced by the host.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario                      | Setup/action                                                             | Required observation                                                                        |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Three-milestone project       | Run dependencies, a parallel opportunity, a failed check, and repair.    | Delivered evidence traces back to each requirement.                                         |
| Manager replaced              | Discard its conversation and restart the service.                        | Goals, decisions, limits, and pending work remain available.                                |
| Change/nonprogress/completion | Change requirements, request unlimited child tasks, and exhaust repairs. | Replans are explicit, authority stays bounded, and completed projects stop generating work. |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Improve decomposition, prompts, role composition, and planning heuristics. Judge progress by verified outcomes, not task count or model activity. A bounded live demonstration waits for A06/A07; synthetic work can proceed earlier.

## Finish and hand off

List completed work packages and the result/evidence for every A05-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
