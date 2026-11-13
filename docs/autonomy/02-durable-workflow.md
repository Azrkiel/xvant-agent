# A02 — Resumable workflow engine

Status: planned. Completion prerequisites: **A01**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

The controller can load an existing run and determine its next legal action using persisted state, even when its old process and model sessions are gone.

## Start here

Inspect `apps/controller/src/orchestrator.ts`, `packages/storage/src/work-graphs.ts`, `packages/storage/src/store.ts`, `apps/controller/src/turn-runner.ts`, `packages/storage/src/integration.ts`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Persist a complete run specification. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Persist a complete run specification

Inventory every value now held only in memory. Persist the executable spec, policy/verifier versions, assignments, attempts, counters, repair allocations, deadlines, workspace/integration identities, and artifact references. Store secret references only.

**Deliver:** A versioned checkpoint schema, migration, and round-trip tests.

### Work package 2: Separate transitions from actions

Extract state advancement from provider/Git effects. Commit each state change and outgoing action intent in one transaction. Dispatch with stable operation/attempt IDs and ownership generation; deduplicate results.

**Deliver:** A durable action queue and one end-to-end node path using it.

### Work package 3: Resume the whole root workflow

Reconstruct planning, execution, checks, review, and repairs from the stored run. Open existing workspaces and preserve completed nodes and limits. Route uncertain effects to A03 rather than automatically resending them.

**Deliver:** A resume entry point and real-process crash tests across workflow stages.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A02-C1:** Restart during planning, node execution, checks, review, and between milestones preserves all necessary executable state.
- [ ] **A02-C2:** A crash before intent commit causes no dispatch; a crash after commit exposes a recoverable pending/uncertain operation.
- [ ] **A02-C3:** Duplicate or stale results do not advance state twice, change current evidence, or reset counters.
- [ ] **A02-C4:** Resume reuses existing integration/workspace identity and does not create a second root graph or repeat completed nodes.
- [ ] **A02-C5:** Persisted budgets, deadlines, plan versions, and retry counters survive restarts and schema migration.
- [ ] **A02-C6:** A malformed, incompatible, or incomplete checkpoint fails explicitly with preserved data.
- [ ] **A02-C7:** Existing success, failure, repair, review, and manual acceptance scenarios retain their documented semantics.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario              | Setup/action                                                              | Required observation                                                          |
| --------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Transaction boundary  | Kill the controller just before and just after intent commit.             | No pre-commit action occurs; committed intent remains discoverable.           |
| Duplicate/late result | Deliver the same result twice and then a result from an obsolete attempt. | State, patches, evidence, and budgets advance at most once.                   |
| Root restart          | Restart during planning, execution, checks, and review.                   | The existing graph/workspace is reused; completed nodes and counters survive. |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

A pure reducer plus dispatcher is recommended, but an equivalent explicit workflow design is welcome. Reuse adapters and preserve legacy semantics. Provider session resume alone is not root-workflow recovery.

## Finish and hand off

List completed work packages and the result/evidence for every A02-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
