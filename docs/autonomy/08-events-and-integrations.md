# A08 — Durable event intake and external integrations

Status: planned. Completion prerequisites: A04, A05, and A07. Read [the overall plan](README.md) first.

## Outcome

Repository events, CI results, owner requests, and schedules can create or update authorized work without lost tasks, duplicate actions, or feedback loops. Start with GitHub and internal timers; keep the interfaces reusable.

Inspect the daemon command surface, storage events, Git operations, and provider/effect interfaces added earlier. Existing UI streams and local sharing are not a durable external event inbox.

## Execution

1. Create a persisted inbox with source, stable event ID, repository/project identity, source revision, received time, processing status, and deduplication key. Commit receipt before acknowledging delivery.
2. Authenticate webhook delivery and limit request sizes/rates. Treat titles, issue bodies, comments, and repository files as untrusted content, not permission grants.
3. Add polling reconciliation with persistent cursors and bounded pagination. Recover from missed webhooks, reordered delivery, source edits, and expired cursors; observe API rate limits.
4. Map events to manager proposals using explicit project rules. Coalesce redundant changes and distinguish new information from repeated notifications.
5. Add durable recurring schedules with declared timezone, missed-run policy, pause state, and deduplication. Bound catch-up after downtime so old timers cannot flood the queue.
6. Implement GitHub PR delivery/update and CI observation through durable effects. Use stable correlation markers and conditional updates where possible; reconcile before replaying uncertain writes.
7. Track agent-originated changes and causal IDs. Prevent its own PR edits, comments, CI runs, and commits from producing infinite new work.
8. Apply least required connector permissions and project/repository allowlists. Notifications and external writes need authority in project policy.

## Success criteria

- **A08-C1:** Duplicate/reordered event delivery creates at most one logical work item per event policy.
- **A08-C2:** Lost webhook events are recovered by polling without losing newer source state.
- **A08-C3:** Restart during receipt, processing, or remote response recording preserves the event/effect outcome.
- **A08-C4:** Agent-generated changes do not produce an unbounded feedback loop.
- **A08-C5:** Events for unknown repositories or invalid signatures cannot authorize work.
- **A08-C6:** Missed schedules, timezone changes, and rate-limit outages have deterministic documented behavior.
- **A08-C7:** A hosted disposable-repository trial demonstrates issue-to-task and verified-candidate-to-PR delivery, with no duplicate PR after a simulated lost acknowledgment.

## Validation and latitude

Use recorded/redacted or synthetic event payloads plus a fake paginated/rate-limited API. Test delivery loss, retries, reordered updates, feedback loops, cursor reset, and actor spoofing. Live connector qualification is separate and uses an authorized repository.

Choose webhooks, polling, or both for the first deployment. Prefer a small reliable integration over many incomplete connectors. Do not publish messages merely because an event arrived; the configured action policy must admit the effect.

## Deliverables and handoff

Inbox, connector interfaces, GitHub adapter, schedule semantics, event-to-work policy, and live integration evidence. A10 displays ingestion lag, cursor health, and pending remote effects.
