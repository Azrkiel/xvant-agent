# A09 — Project memory and lessons

Status: planned. Completion prerequisites: **A01, A05**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

Managers and workers can use current project decisions and relevant prior lessons without treating retrieved text as execution state or authority.

## Start here

Inspect `packages/storage/src/memory.ts`, `packages/storage/src/lessons.ts`, `packages/storage/src/lesson-scope.ts`, `packages/memory`, `packages/context`, `apps/controller/src/lessons.ts`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Persist project decisions. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Persist project decisions

Store decisions, rationale, alternatives, actor/source, requirement links, revision anchors, acceptance, and supersession. Keep proposed, accepted, inferred, and authoritative operational records distinct.

**Deliver:** A decision schema and reloadable project knowledge view.

### Work package 2: Retrieve only eligible knowledge

Scope and bound retrieval by project/task/current revision. Apply freshness, forgetting, access, and provenance rules to packets and external-runtime search tools. Define retention and proposal-only imports.

**Deliver:** Measured retrieval and access/freshness tests.

### Work package 3: Measure lesson use

Record exposure, context, verification quality, and repair outcomes. Make lessons-on/off comparisons use isolated or deliberately seeded stores, without claiming efficacy from anecdotal success.

**Deliver:** Instrumentation and reproducible experimental configurations for A11.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A09-C1:** Cross-project, rejected, forgotten, and ineligible stale knowledge cannot enter an authorized task packet.
- [ ] **A09-C2:** A manager restart reconstructs decisions from persisted records without relying on its old conversation.
- [ ] **A09-C3:** Worker-authored memory cannot change permissions, budgets, verification policy, or authoritative task state.
- [ ] **A09-C4:** Changed code/requirements invalidate affected knowledge according to tested rules.
- [ ] **A09-C5:** Import/export preserves provenance and does not silently grant accepted status.
- [ ] **A09-C6:** Retrieval is bounded by documented size/latency targets on a representative retained corpus.
- [ ] **A09-C7:** The qualification harness can compare memory/lessons enabled versus disabled with controlled task allocation and separate stores.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario                 | Setup/action                                                                            | Required observation                                                               |
| ------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Poisoned/stale knowledge | Offer a forged instruction, changed file anchor, forgotten fix, or superseded decision. | Ineligible knowledge is excluded or explicitly labeled; it cannot grant authority. |
| Scope/import boundary    | Query another project or import accepted-looking external memory.                       | Access is denied and imports remain proposals.                                     |
| Useful retrieval         | Load a representative corpus and replace the manager session.                           | Decisions persist; documented retrieval limits and provenance are preserved.       |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Improve ranking, indexing, and summaries using measurements. Choose size/latency targets before measuring and report them. Preserve required context facts; add a new database only when justified. Workflow truth remains in durable execution records.

## Finish and hand off

List completed work packages and the result/evidence for every A09-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
