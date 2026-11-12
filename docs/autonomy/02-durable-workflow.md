# A02 — Resumable workflow engine and durable dispatch

Status: planned. Completion prerequisite: A01. Read [the overall plan](README.md) first.

## Outcome and source map

A run's next legal action can be reconstructed from durable state after the controller disappears. Existing provider adapters remain reusable. Merely storing progress snapshots or resuming a provider session does not meet this milestone.

Start with `apps/controller/src/orchestrator.ts`, `packages/storage/src/work-graphs.ts`, `packages/storage/src/store.ts`, `apps/controller/src/turn-runner.ts`, and `packages/storage/src/integration.ts`. The current run creates fresh state and keeps counters, busy/completed sets, and repair bookkeeping in memory.

## Execution

1. Persist the complete executable specification, selected policy/verifier versions, worker configuration, plan revision, attempts, counters, repair allocations, deadlines, pending checks, integration identity, and artifact references. Persist credential references, never credential values.
2. Extract deterministic state transitions from orchestration effects. A suggested interface is `advance(runId)`: load state, derive eligible transitions, commit state plus action intents, and let a separate dispatcher execute them.
3. Introduce a durable outbox/action journal with stable operation IDs, fencing generation, claim state, attempt identity, expected input revisions, and result deduplication. Commit graph changes and outgoing intents in one SQLite transaction.
4. Record results transactionally with state advancement. Receiving the same result twice must not apply a patch or consume budget twice. Late results from an invalid attempt must be retained for diagnosis or rejected without advancing current state.
5. Use stable artifact publication: write content, verify hash, atomically publish its reference. Missing artifacts or incomplete writes block continuation rather than imply success.
6. Provide a resume/load path that opens the existing integration workspace, reconstructs eligible nodes, and preserves completed nodes and repair limits. Let A03 reconcile ambiguous external effects before redispatch.
7. Migrate incrementally: retain legacy entry points as wrappers where useful and compare their intended behavior against the new engine.

## Success criteria

- **A02-C1:** Restart during planning, node execution, checks, review, and between milestones preserves all necessary executable state.
- **A02-C2:** A crash before intent commit causes no dispatch; a crash after commit exposes a recoverable pending/uncertain operation.
- **A02-C3:** Duplicate or stale results do not advance state twice, change current evidence, or reset counters.
- **A02-C4:** Resume reuses existing integration/workspace identity and does not create a second root graph or repeat completed nodes.
- **A02-C5:** Persisted budgets, deadlines, plan versions, and retry counters survive restarts and schema migration.
- **A02-C6:** A malformed, incompatible, or incomplete checkpoint fails explicitly with preserved data.
- **A02-C7:** Existing success, failure, repair, review, and manual acceptance scenarios retain their documented semantics.

## Validation and latitude

Use deterministic transition tests plus actual controller-death tests at transaction/dispatch/result boundaries. Assert both durable state and observable calls; mocking only the storage API is insufficient. Add a trace that reconstructs a run without a transcript or in-memory cache.

Choose a reducer, explicit state machine, or a small embedded workflow abstraction. Reuse existing persistence and fencing unless evidence justifies replacement. Avoid a distributed workflow platform before demonstrating a single-host requirement it solves.

## Deliverables and handoff

Engine, action dispatcher, storage migration, compatibility wrappers, and crash-boundary test inventory. Document pending versus uncertain actions for A03 and claim/dispatch contracts for A04. Do not report ambiguous-effect recovery complete here.
