# A04 — Always-on daemon and durable scheduler

Status: planned. Completion prerequisite: A03. Read [the overall plan](README.md) first.

## Outcome

Execution survives UI/CLI disconnects and service restarts. The daemon owns scheduling, recovery, and the authoritative store; clients issue authenticated, idempotent commands. A service that merely restarts the old run-from-scratch entry point is insufficient.

Start with `apps/controller/src/app.ts`, `service.ts`, `http/app-server.ts`, `scripts/xvant.mjs`, and storage leases. Current app active/busy maps are process-local. Replace their authoritative role with durable claims; caches may remain as derived conveniences.

## Execution

1. Add daemon start/stop/status interfaces and a production service definition for the selected Linux host. Specify local state paths, permissions, child reaping, signals, readiness, and startup recovery.
2. Implement a persisted runnable queue, claims with generations, wake-up timers, retry eligibility, priorities, and concurrency accounting. Claim work atomically under the current controller owner.
3. Reconstruct queues and pending reconciliation on startup. Persist wait reasons and next eligible times; network/auth/quota blocks must not cause tight loops.
4. Provide fairness across projects and prevent overlapping writers to shared resources. Enforce admission budgets before claiming execution slots. Resource reservations must survive reboot.
5. Make CLI/UI commands authenticated and idempotent. Distinguish cancel, pause intake, pause dispatch, drain, and service shutdown. Report which in-flight operations still require reconciliation.
6. Handle clock changes and suspend/resume: use appropriate monotonic timing within a process and persisted wall-time intent across restarts. Do not infer remote operation completion from elapsed local time.
7. Expose liveness, readiness, last meaningful progress, oldest runnable work, outstanding reconciliation, queue depth, and resource usage. Configure watchdog/restart behavior without overlapping authoritative controllers.

## Success criteria

- **A04-C1:** Accepted queued work survives daemon death and host reboot.
- **A04-C2:** Closing or reconnecting clients neither stops work nor submits it twice.
- **A04-C3:** Two daemon starts cannot both become authoritative; takeover fences obsolete commands and results.
- **A04-C4:** Due authorized work is scheduled under available resources; busy projects cannot indefinitely starve another eligible project.
- **A04-C5:** Pause, drain, cancellation, and shutdown have documented, observed semantics and bounded response times.
- **A04-C6:** Clock jumps and suspend/resume preserve limits and uncertainty.
- **A04-C7:** Idle/blocked projects use bounded resources and make no repeated model calls without a meaningful wake-up.

## Validation and latitude

Use real service restarts and a controlled reboot drill on the supported host. Set explicit scheduling and shutdown bounds before measuring them; record load and host conditions. Exercise duplicate commands, crash after claim, lost lease, and a backlog larger than concurrency.

Choose polling versus event-driven internal scheduling and service-manager integration. Keep the first implementation single-host. Do not add distributed locks, broker infrastructure, or multiple writable SQLite replicas without a justified requirement.

## Deliverables and handoff

Daemon/service configuration, durable scheduler, command API, host setup documentation, and restart/reboot evidence. Publish queue/claim semantics for A05 and health/control contracts for A10.
