# A01 — Project, authority, and completion contracts

Status: planned. Completion prerequisite: A00. Read [the overall plan](README.md) first.

## Outcome and existing behavior

Define the contract between the owner, project manager, host, and workers. The host must be able to decide whether work is authorized and whether it qualifies for completion without trusting a model's self-assessment.

Inspect `packages/contracts/src`, `packages/core/src/plan.ts`, `apps/controller/src/orchestrator.ts`, `apps/controller/src/app.ts`, `scripts/xvant.mjs`, and `packages/policy/src`. Today an empty check set is allowed, and a root with a rejected review can reach `ready` for human disposition. Preserve useful manual workflows, but never interpret that state as automatic acceptance.

## Execution

1. Introduce versioned project specification and autonomy policy schemas. Include objectives, exclusions, milestone criteria, repositories, scopes, verifier references, required review, allowed actions/providers, resource ceilings, escalation rules, and policy owner/version.
2. Separate workflow phase from verification, review, acceptance, and promotion decisions. Define legal transitions and structured reasons. Suggested phases include queued, running, waiting, reconciling, blocked, completed, cancelled; evidence and acceptance need their own records.
3. Define immutable task and attempt identities, parent-child relationships, requirement IDs, candidate revision, policy/spec versions, and result envelopes. Child authority and aggregate budgets may only narrow the parent allocation.
4. Implement a deterministic completion predicate. It must reject missing verification, unknown effects, stale hashes, rejected or unavailable required reviews, and unauthorized scopes. Non-code tasks need an explicit evidence policy rather than a hidden no-op success.
5. Define manual override semantics separately: actor, authority, reason, exact candidate, expiry/revalidation, and audit record. A manual exception cannot masquerade as autonomous verification.
6. Define version-upgrade behavior for existing records. Legacy runs retain their original meaning and cannot silently acquire unattended permissions.

## Success criteria

- **A01-C1:** Valid project/task/policy inputs parse; unsupported versions and contradictory or excessive child permissions fail deterministically.
- **A01-C2:** The completion truth table covers empty checks, stale evidence, modified verifier, missing review, rejection, unknown outcome, changed scope, and valid acceptance.
- **A01-C3:** A human-review-ready result remains distinct from an automatically acceptable candidate.
- **A01-C4:** Duplicate commands and stale state versions cannot repeat acceptance or overwrite decisions.
- **A01-C5:** Legacy data migrations preserve meaning, and an old run cannot gain authority by default.
- **A01-C6:** Policy changes invalidate relevant outstanding authorizations and evidence according to documented rules.

## Validation and latitude

Use table/property tests for legal transitions and policy narrowing; demonstrate that a worker cannot modify acceptance criteria through its result payload. Test a legacy database upgrade and manual acceptance compatibility. Run the applicable integrated gate.

Choose schema layout, state names, and whether policy is embedded or referenced by immutable hash. Keep the transition and trust semantics explicit. Do not require routine owner confirmation for decisions already covered by the configured policy.

## Deliverables and handoff

Schemas, completion/admission functions, compatibility/migration rules, and a compact state/authority reference. A02, A05, A06, and A07 consume these interfaces. List stable IDs and version rules in the handoff.
