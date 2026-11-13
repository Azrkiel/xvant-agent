# A08 — Reliable events and external integrations

Status: planned. Completion prerequisites: **A04, A05, A07**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

GitHub events and schedules reliably create authorized work, and XVANT can deliver verified results without duplicate PRs or self-triggered loops.

## Start here

Inspect `apps/controller/src/http`, `packages/storage/src`, `scripts/xvant.mjs`, `the daemon and effect interfaces from A03/A04`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Persist incoming events. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Persist incoming events

Add source/event/repository identity, source revision, processing state, deduplication, and authenticated size-bounded delivery. Commit receipt before acknowledgment; treat event bodies as untrusted input.

**Deliver:** A durable inbox and event-to-work rules.

### Work package 2: Recover missed information

Implement bounded polling/cursors, ordering/coalescing rules, API rate-limit behavior, and recurring schedules with explicit timezone/missed-run policies.

**Deliver:** Restartable ingestion and timers without catch-up floods.

### Work package 3: Deliver and observe remote work

Use journaled correlation-aware effects for GitHub PR creation/update and CI observation. Track causality so agent commits, edits, and CI runs do not repeatedly create the same work.

**Deliver:** A disposable hosted-repository issue-to-task and candidate-to-PR trial.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A08-C1:** Duplicate/reordered event delivery creates at most one logical work item per event policy.
- [ ] **A08-C2:** Lost webhook events are recovered by polling without losing newer source state.
- [ ] **A08-C3:** Restart during receipt, processing, or remote response recording preserves the event/effect outcome.
- [ ] **A08-C4:** Agent-generated changes do not produce an unbounded feedback loop.
- [ ] **A08-C5:** Events for unknown repositories or invalid signatures cannot authorize work.
- [ ] **A08-C6:** Missed schedules, timezone changes, and rate-limit outages have deterministic documented behavior.
- [ ] **A08-C7:** A hosted disposable-repository trial demonstrates issue-to-task and verified-candidate-to-PR delivery, with no duplicate PR after a simulated lost acknowledgment.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario                     | Setup/action                                                        | Required observation                                                        |
| ---------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Duplicate/out-of-order event | Repeat deliveries and edit the remote object before processing.     | One logical work item reflects the applicable current state.                |
| Webhook/cursor outage        | Lose deliveries, expire a cursor, and hit rate limits.              | Polling recovers information with bounded work.                             |
| Remote write feedback        | Lose a PR-create acknowledgment and replay agent-originated events. | Reconciliation finds the result; no duplicate PR or unbounded loop appears. |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Start with polling, webhooks, or both. Keep the first connector small and reliable. Incoming text cannot authorize external writes or work in unknown repositories; admit actions against project policy.

## Finish and hand off

List completed work packages and the result/evidence for every A08-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
