# A07 — Verification and autonomous integration

Status: planned. Completion prerequisites: **A03, A06**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

Qualifying changes can be accepted and integrated automatically under project policy, with proof bound to the exact result and target revision.

## Start here

Inspect `apps/controller/src/native-verifier.ts`, `apps/controller/src/native-review.ts`, `apps/controller/src/orchestrator.ts`, `packages/storage/src/integration.ts`, `scripts/xvant.mjs`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Define trusted verification profiles. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Define trusted verification profiles

Specify evidence for bug fixes, features, refactors, docs, dependencies, and investigations. Separate worker-proposed tests from trusted criteria. Run repository checks in an appropriate sandbox.

**Deliver:** Versioned task-class verification profiles and immutable receipts.

### Work package 2: Evaluate autonomous acceptance

Check source/requirements/policy/verifier versions, integrated checks, required review, scope, and unresolved effects. Track reviewer contribution history; preserve explicit manual exceptions.

**Deliver:** An explainable host acceptance decision that rejects missing or stale proof.

### Work package 3: Serialize integration

Queue candidates per repository, compare target heads, rebuild/reverify changed combinations, and promote the accepted revision through journaled effects. Separate PR, merge, and deployment authority.

**Deliver:** An integration queue with crash/target-drift recovery and compensation guidance.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A07-C1:** Valid authorized work completes through acceptance and integration without routine intervention.
- [ ] **A07-C2:** Empty verification, weakened trusted tests, rejected/missing required review, and stale receipts prevent auto-acceptance.
- [ ] **A07-C3:** A target-head change before promotion invalidates the relevant candidate checks; untested combinations cannot be merged.
- [ ] **A07-C4:** Duplicate commands, crashes around merge, and lost remote replies cause no duplicate logical promotion.
- [ ] **A07-C5:** Every promoted revision is traceable to exact evidence and a policy decision; model summaries alone cannot authorize it.
- [ ] **A07-C6:** Tests and review execute with appropriate isolation; executing repository tests is not treated as harmless host code.
- [ ] **A07-C7:** An explicit manual override remains identifiable and cannot be reused for a different revision or scope.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario              | Setup/action                                                                                  | Required observation                                                           |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| False success         | Return a self-authored receipt, remove trusted tests, omit checks, or reject required review. | Automatic acceptance is refused.                                               |
| Target moves          | Change the destination branch after the candidate was checked.                                | Affected checks rerun on the actual integration candidate.                     |
| Promotion interrupted | Lose a reply after merge or repeat the accept command.                                        | No duplicate logical promotion; exact evidence and policy remain attributable. |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Choose task profiles, queue structure, and reviewer composition. Prefer meaningful independent checks. Automatic deployment may remain unsupported; merge authority does not imply permission to deploy or perform unrelated external actions.

## Finish and hand off

List completed work packages and the result/evidence for every A07-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
