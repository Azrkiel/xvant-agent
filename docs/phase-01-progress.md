# Phase 1 implementation

- [x] P01.1 Workspace, pinned tools, strict types, lint, format, CI
- [x] P01.2 Contracts and immutable lifecycle transitions
- [x] P01.3 Dependency DAG and bounded hierarchy
- [x] P01.4 Deterministic simulated adapter
- [x] P01.5 In-memory controller and trusted verification
- [x] P01.6 Offline gate and machine-readable evidence

G01 is qualified locally on Windows. The final run receipt is in `docs/evidence/G01.json`; its source manifest identifies the exact uncommitted file contents tested. Linux CI is configured but has not run here.

Phase 0 development tools are qualified for this scope. Full G00, live provider authentication, subscription scope, and protocol checks remain pending. Phase 1 makes no model calls.

## Implemented contract decisions

- `workRevision` changes when objective, required checks, or acceptance criteria change. `rowVersion` changes on state mutations. State transitions do not stale valid evidence.
- Verification receipts bind task, attempt, work revision, tree hash, and artifact-set hash. The controller generates receipts from registered trusted callbacks; worker events cannot submit receipts.
- Raw adapter events are `unknown` until validated. The controller retains its own dispatch identity and passes an isolated request copy to the adapter.
- Graph validation accepts one to twenty nodes. Dependency DAG depth is separate from a parent hierarchy's three-level limit. Phase 1 exposes graph validation as a pure contract; scheduling a dependency graph belongs to Phase 6.
- Unknown/malformed/unterminated outcomes require attention without retry. Quota and failure outcomes also stop without automatic retry.
- Runtime kind is restricted to `simulated` in this phase. Provider kinds and capabilities enter with qualified adapters in Phase 3.
- Verification and adapter callbacks are trusted in-process code. Process timeouts, forceful cancellation, persistent recovery, and service authorization are Phase 2 work.

## Verification

Real Vitest red runs preceded lifecycle, graph, adapter/controller, and gate implementations. Raw red reports remain in `.artifacts`; `docs/evidence/phase-01-tdd.json` records their counts and hashes. The earlier planning snippet audit remains a separate historical check.

The gate runs strict types, lint, format, coverage, per-suite discovery validation, and the actual demo. Current test minima total 110 across six files. Coverage thresholds are 80% overall and 90% branches for task transitions and graph validation.

Review fixed an adapter request-mutation bug, corrected graph parameterized fixtures, removed unused temporary bindings, and corrected the gate-policy coverage include. See `docs/evidence/phase-01-review.json`.

## Next phase

Phase 2 starts with SQLite persistence, durable attempts/events, recovery decisions, workspace leases, and process supervision. No Phase 2 code has been started.
