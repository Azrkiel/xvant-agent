# A06 — Isolation and resource budgets

Status: planned. Completion prerequisites: **A01, A02**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

Every worker, including native provider tools, is confined to its granted environment and resources; restarts and child tasks cannot expand its allocation.

## Start here

Inspect `packages/supervisor`, `packages/policy`, `packages/tools`, `packages/contracts/src/live.ts`, `packages/native-agent/src/loop.ts`, `apps/controller/src`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Define and implement one worker boundary. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Define and implement one worker boundary

Specify workspace mounts, network access, secret references, environment identity, lifecycle, and artifact export. Qualify one Linux backend without unrelated host files, controller state, or host sockets.

**Deliver:** A disposable execution environment with an explicit threat model.

### Work package 2: Run real provider tools inside it

Launch native CLIs inside the boundary with minimal credentials/configuration. Enforce CPU, memory, process, disk, duration, and descendant termination limits. Validate exported artifacts before host integration.

**Deliver:** A provider/profile capability matrix backed by actual boundary checks.

### Work package 3: Reserve project resources durably

Add transactional global/project/child budget allocation, usage reconciliation, conservative handling of unknown usage, bounded backoff, and circuit breakers. Preserve uncertain reservations.

**Deliver:** A budget ledger and concurrency/restart tests.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A06-C1:** Adversarial workers cannot read/write another workspace, controller database, unrelated secrets, or prohibited network endpoints.
- [ ] **A06-C2:** Native provider tools obey the enforced boundary in live qualification for each admitted profile.
- [ ] **A06-C3:** Deadline/resource violations terminate the whole owned execution environment and preserve recoverable state.
- [ ] **A06-C4:** Concurrent dispatch cannot oversubscribe reserved limits; restarts and child tasks cannot replenish them.
- [ ] **A06-C5:** Unknown usage is visible and handled conservatively; claimed financial caps match actual enforcement.
- [ ] **A06-C6:** Credential material is absent from persistent prompts, public logs, and exported evidence.
- [ ] **A06-C7:** Unsupported isolation/auth routes fail closed with an actionable capability report.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario                    | Setup/action                                                                              | Required observation                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Boundary attack             | Try other project paths, secrets, symlinks, prohibited network targets, and host sockets. | The declared boundary is enforced, including native tools.                     |
| Resource exhaustion         | Grow processes, disk use, memory, or runtime beyond limits.                               | The owned environment stops with recoverable state and no escaped descendants. |
| Concurrent/resumed spending | Race dispatches, restart, and create child tasks with partial usage telemetry.            | Limits are not replenished or oversubscribed; unknown usage is not zero.       |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Choose containers, OS isolation, or a stronger sandbox appropriate to the claim. Support only qualified provider/auth routes. Do not promise an exact monetary cap without an enforceable mechanism, disable TLS, or bypass quota blocks through another account.

## Finish and hand off

List completed work packages and the result/evidence for every A06-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
