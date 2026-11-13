# A03 — Recovery and reconciliation

Status: planned. Completion prerequisites: **A02**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

After interruption, XVANT establishes what happened and chooses continue, repair, retry, or block without blindly repeating uncertain effects.

## Start here

Inspect `packages/storage/src/providers.ts`, `packages/storage/src/store.ts`, `packages/storage/src/integration.ts`, `apps/controller/src`, `tests/faults`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Classify recovery outcomes. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Classify recovery outcomes

Define not-started, owned/running, completed/verifiable, stopped/incomplete, and unresolved observations. Persist probe provenance and decisions. Identify workers by environment/start identity as well as PID.

**Deliver:** A recovery state table, probe interfaces, and capability declarations.

### Work package 2: Recover worker and Git actions

Probe or stop/reconcile owned workers; preserve incomplete artifacts. Recognize integration commits created before database acknowledgment. Refuse unrelated dirty workspaces or unexpected heads.

**Deliver:** Recovery adapters and crash tests for worker/Git persistence gaps.

### Work package 3: Handle remote ambiguity and takeover

Add stable correlation/idempotency support, conditional operations, bounded probe retries, and reservation release rules. Fence obsolete dispatchers where possible; keep conflicting work blocked when an old external effect cannot be ruled out.

**Deliver:** A fake external-service demonstration and actionable blocked-state information.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A03-C1:** Every mandatory crash boundary produces one documented recovery classification, never fabricated success.
- [ ] **A03-C2:** Already integrated work is recognized and not applied twice after a database acknowledgment is lost.
- [ ] **A03-C3:** A still-running or unidentifiable worker prevents conflicting dispatch; a stale worker result cannot authorize promotion.
- [ ] **A03-C4:** Lost external responses do not create duplicate observable effects in the idempotent test service.
- [ ] **A03-C5:** A service without reliable deduplication/lookup remains explicitly blocked when its outcome is ambiguous.
- [ ] **A03-C6:** PID reuse, missing artifacts, dirty workspaces, and unexpected Git heads fail safely without deleting user changes.
- [ ] **A03-C7:** A controller restart can resume a reconciled run without resetting its limits or starting the whole project again.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario                | Setup/action                                                                       | Required observation                                                  |
| ----------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Git acknowledgment lost | Commit the patch, then kill before the database records it.                        | Recovery recognizes the commit and does not apply it again.           |
| Old worker survives     | Lose the lease while a worker remains alive; include PID reuse.                    | No conflicting dispatch or stale-result acceptance occurs.            |
| Remote response lost    | Execute the action but lose the reply, with and without remote lookup/idempotency. | Recognizable work is reconciled; irreducible ambiguity stays blocked. |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Choose probes and attachment strategies from demonstrated provider capabilities. Safely stopping and replacing a worker is acceptable. A timeout alone cannot establish that the old action never happened.

## Finish and hand off

List completed work packages and the result/evidence for every A03-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
