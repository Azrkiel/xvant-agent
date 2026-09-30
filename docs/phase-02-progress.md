# Phase 2: durable execution

The Windows offline path now composes SQLite storage, an authenticated loopback API, isolated simulated workers, and host-registered process checks. `docs/evidence/G02.json` is the authoritative gate result for its source manifest. No live provider or Linux qualification is implied.

## Implemented scope

- P02.1: SQLite WAL, FULL synchronous commits, foreign keys, bounded busy timeout, versioned transactional migrations. Ownership is checked before migrations. Commands, task state, events, operation records and outbox intent commit together.
- P02.2: content-addressed artifacts are flushed before references become visible. Immutable diagnostic objects have database references and snapshot manifests. Event replay uses increasing cursors; command changes use expected task row versions.
- P02.3: one renewable controller lease, monotonically increasing controller generations, random operation tokens, and exclusive workspace/session/worker reservations. Reservations remain held through verification and uncertain recovery.
- P02.4: owned child handles, bounded combined output, hard deadlines, graceful/forced shutdown attempts, identity-checked cancellation, and global admission stop. Windows ordinary descendants are tested. Linux process groups are implemented but require a Linux gate run.
- P02.5: seven real subprocess crash points. Unknown send, acknowledgement, result, or verifier outcomes never automatically retry. Trusted host reconciliation can attest `not_started` or `stopped`; this capability is not exposed to HTTP callers.
- P02.6: loopback-only Host checking, one-use capability exchange, HttpOnly SameSite cookie, same-origin checks, CSRF token, bounded JSON bodies, safe error codes and persisted command idempotency. HTTP supports create, queue, dispatch, accept, and bounded event replay.
- P02.7: simulation and explicitly approved trusted-local execution only. Restricted filesystem/network/hostile-code profiles return unsupported. No silent downgrade.
- P02.8: SQLite online backups, retained immutable artifacts, SHA256 manifests, schema/constraint/integrity validation, restore to a new destination, and failed-migration rollback.

## Important boundaries

Only simulated workers are wired into the durable controller. Their source/artifact-set hashes are synthetic and remain labeled simulated. Separately stored artifacts demonstrate durable diagnostic storage; they are not proof of real code changes. Trusted check programs are registered by the host, never by an HTTP request.

Workspace and session IDs are reservation identities, not filesystem isolation. A worktree is not a sandbox. Windows taskkill and Linux process groups do not contain detached/escaped descendants, and there is no Job Object/cgroup integration or persisted process reattachment. An uncertain shutdown retains reservations. A new controller fences results and requires reconciliation instead of killing an old numeric PID.

The database must live on a local, nonsynchronized disk. Network shares and sync folders are outside the qualified storage configuration. Backups contain task data; keep them private. Restores preserve captured controller lease expiry, so immediate opening may return LEASE_BUSY until the old TTL passes (normally at most 30 seconds). This avoids silently rewriting ownership metadata. There is no restore-over-live-database operation.

Windows has no portable Node directory fsync. Objects and snapshots use file fsync and atomic rename; power-loss durability of directory entries is not independently certified.

The event endpoint provides bounded JSON replay. SSE/live UI streaming, native provider event deduplication, real repository attestation, and a user-facing reconciliation flow remain follow-up integration work.

## Verification and lessons applied

Use `npm run gate -- --phase 02 --offline`. It checks types, lint, formatting, coverage, minimum discovery for every boundary suite, no skipped tests, a stable source manifest, and a direct Node runtime demo. The demo executes a simulated task, runs a process check, restarts the store, accepts persisted evidence, and validates backup/restore.

Real failing tests preceded storage, durable orchestration, HTTP, artifacts, service composition, gate policy, and review fixes. Raw red reports live in `.artifacts`. Review caught early reservation release, migrations preceding exclusivity, idle lease expiry, admission after stop, synchronous verifier errors, uncertain verifier release, and snapshot schema constraints. Subprocess tests also caught TypeScript syntax that Vitest transpilation had hidden.

Do not run the final gate while another agent edits source. One preflight overlapped new red tests and correctly failed. Stop edits, format, then gate once against a stable tree.

## Next

1. Read the latest handoff and rerun G02 before further edits.
2. Obtain a real Linux gate receipt; CI configuration alone is not evidence.
3. Before Phase 3 live adapters, qualify the selected official auth route, billing/subscription limits, native session IDs, protocol version, interruption and reconciliation. Do not add paid fallback.
4. Add stronger OS containment before permitting untrusted generated programs. Until then report unsupported profiles explicitly.
