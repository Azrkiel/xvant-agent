# A03 — Recovery, reconciliation, and effect identity

Status: planned. Completion prerequisite: A02. Read [the overall plan](README.md) first.

## Outcome and boundaries

After interruption, establish what happened before deciding whether to continue, retry, repair, or block. Preserve the existing rule that unknown outcomes are never blindly replayed. A finite timeout is not proof that a remote action failed.

Inspect `packages/storage/src/providers.ts`, `packages/storage/src/store.ts`, `packages/storage/src/integration.ts`, provider controllers, and fault fixtures. Existing recovery marks open operations unknown and retains reservations; build evidence-driven reconciliation above that behavior.

## Execution

1. Define reconciliation observations: definitely not started, owned and running, completed with verifiable artifacts, stopped incomplete, and unresolved. Store provenance, observation time, actor/probe identity, and resulting decision.
2. Implement adapter-specific probes and recovery capability declarations. Where reliable reattachment is unsupported, observe or terminate the owned environment, verify it stopped, preserve artifacts, then create an explicit new attempt if policy permits.
3. Track worker identity beyond PID alone: process start identity, execution environment, lease/generation, provider session/turn, and workspace. PID reuse must not authorize killing or trusting another process.
4. Reconcile Git integration using expected base/head, patch or operation identity, and recorded commit metadata. Cover commit-created/database-update-lost and patch-partially-applied cases without overwriting unrelated work.
5. Define the reusable external-effect interface: stable correlation key, idempotency capability, lookup/probe, expected versions, and ambiguity outcome. Provide a fake external service now; concrete GitHub integration follows in A08.
6. Prevent stale effect execution after lease takeover. Couple dispatch to ownership checks, terminate/fence obsolete workers, and use remote conditional operations where supported. If an old in-flight effect cannot be conclusively fenced, block conflicting promotion and reconcile it.
7. Schedule reconciliation with bounded backoff and deadlines. Release reservations only with sufficient evidence. Give unresolved cases actionable operator information.

## Success criteria

- **A03-C1:** Every mandatory crash boundary produces one documented recovery classification, never fabricated success.
- **A03-C2:** Already integrated work is recognized and not applied twice after a database acknowledgment is lost.
- **A03-C3:** A still-running or unidentifiable worker prevents conflicting dispatch; a stale worker result cannot authorize promotion.
- **A03-C4:** Lost external responses do not create duplicate observable effects in the idempotent test service.
- **A03-C5:** A service without reliable deduplication/lookup remains explicitly blocked when its outcome is ambiguous.
- **A03-C6:** PID reuse, missing artifacts, dirty workspaces, and unexpected Git heads fail safely without deleting user changes.
- **A03-C7:** A controller restart can resume a reconciled run without resetting its limits or starting the whole project again.

## Validation and latitude

Inject death before send, after send, after external commit, before receipt persistence, and after receipt persistence. Assert call counts, remote objects, Git history, ownership, and reservations. Include lease takeover while an old worker remains alive.

Choose reconciliation probes and worker attachment strategies based on qualified provider capabilities. It is acceptable to stop and replace a worker when safe continuation is unavailable. It is not acceptable to convert uncertainty into a retry merely to increase completion rate.

## Deliverables and handoff

Reconciler, effect interface, provider capability matrix, operator-visible blocked reasons, and fault evidence. A04 consumes wake-up and retry contracts; A07/A08 must use the effect interface rather than inventing unjournaled writes.
