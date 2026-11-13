# A04 — Always-on daemon and scheduler

Status: planned. Completion prerequisites: **A03**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

A background service owns execution and durable scheduling; closing a CLI/UI or restarting the host does not lose accepted work.

## Start here

Inspect `apps/controller/src/app.ts`, `apps/controller/src/service.ts`, `apps/controller/src/http/app-server.ts`, `packages/storage/src/store.ts`, `scripts/xvant.mjs`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Move execution into a service. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Move execution into a service

Add daemon start/stop/status and authenticated idempotent client commands. Define state paths, readiness, signals, child reaping, and service-manager configuration. Perform recovery before dispatch.

**Deliver:** An installable single-host service that can load an existing run.

### Work package 2: Persist scheduling decisions

Store runnable work, claims/generations, priorities, retry/wake-up times, reservations, and wait reasons. Claim atomically; apply concurrency limits and fairness across projects.

**Deliver:** A scheduler that reconstructs its queue after restart.

### Work package 3: Make lifecycle observable

Define pause intake, pause dispatch, drain, cancel, and shutdown. Handle clock jumps and suspend/resume. Expose progress age, queue lag, reconciliation, ownership, and resources.

**Deliver:** CLI/API controls and real restart/reboot demonstrations.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A04-C1:** Accepted queued work survives daemon death and host reboot.
- [ ] **A04-C2:** Closing or reconnecting clients neither stops work nor submits it twice.
- [ ] **A04-C3:** Two daemon starts cannot both become authoritative; takeover fences obsolete commands and results.
- [ ] **A04-C4:** Due authorized work is scheduled under available resources; busy projects cannot indefinitely starve another eligible project.
- [ ] **A04-C5:** Pause, drain, cancellation, and shutdown have documented, observed semantics and bounded response times.
- [ ] **A04-C6:** Clock jumps and suspend/resume preserve limits and uncertainty.
- [ ] **A04-C7:** Idle/blocked projects use bounded resources and make no repeated model calls without a meaningful wake-up.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario              | Setup/action                                                     | Required observation                                                              |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Disconnect/reboot     | Queue work, disconnect the client, then restart the daemon/host. | Work survives and continues according to recovery state.                          |
| Competing controllers | Start two controllers and force ownership takeover.              | Only the valid owner advances execution.                                          |
| Scheduling and idle   | Mix busy, blocked, due, and idle projects; alter the clock.      | Eligible work progresses fairly and idle/blocked work causes no tight model loop. |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Choose internal polling or event delivery and suitable service-manager integration. Set measurable scheduling/shutdown bounds before testing. Keep SQLite single-host; a distributed broker is not required.

## Finish and hand off

List completed work packages and the result/evidence for every A04-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
