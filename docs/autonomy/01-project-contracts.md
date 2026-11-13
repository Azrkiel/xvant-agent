# A01 — Project and completion contracts

Status: planned. Completion prerequisites: **A00**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

The host can determine whether a task is authorized and complete from versioned policy and evidence, independently of a model saying it is done.

## Start here

Inspect `packages/contracts/src`, `packages/core/src/plan.ts`, `packages/policy/src`, `apps/controller/src/orchestrator.ts`, `apps/controller/src/app.ts`, `scripts/xvant.mjs`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Define project and task records. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Define project and task records

Introduce versioned objectives, exclusions, requirement IDs, repository/path scope, verifier references, review requirements, allowed actions/providers, budgets, and escalation rules. Specify immutable task/attempt identities and narrower child authority.

**Deliver:** Schemas, examples, and a documented compatibility strategy.

### Work package 2: Make completion a host decision

Separate workflow phase, verification, review, acceptance, and integration. Implement a deterministic decision function. Keep human-review readiness distinct from autonomous acceptance; define evidence for non-code tasks too.

**Deliver:** A completion/admission truth table with behavior tests.

### Work package 3: Preserve legacy meaning

Migrate existing records without silently granting unattended permissions. Define explicit manual exceptions and how policy/verifier changes invalidate outstanding decisions.

**Deliver:** Migration fixtures, legacy workflow coverage, and stable interfaces for A02.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A01-C1:** Valid project/task/policy inputs parse; unsupported versions and contradictory or excessive child permissions fail deterministically.
- [ ] **A01-C2:** The completion truth table covers empty checks, stale evidence, modified verifier, missing review, rejection, unknown outcome, changed scope, and valid acceptance.
- [ ] **A01-C3:** A human-review-ready result remains distinct from an automatically acceptable candidate.
- [ ] **A01-C4:** Duplicate commands and stale state versions cannot repeat acceptance or overwrite decisions.
- [ ] **A01-C5:** Legacy data migrations preserve meaning, and an old run cannot gain authority by default.
- [ ] **A01-C6:** Policy changes invalidate relevant outstanding authorizations and evidence according to documented rules.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario               | Setup/action                                                                                             | Required observation                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Completion truth table | Try no checks, stale evidence, missing/rejected required review, unknown outcome, and a valid candidate. | Only the qualifying candidate is automatically acceptable.                 |
| Permission inheritance | A child or worker result requests broader scope or new authority.                                        | Host admission rejects the expansion.                                      |
| Legacy run             | Upgrade a database and change policy on an outstanding run.                                              | Original meaning is preserved; affected authority/evidence is invalidated. |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Choose schema names and policy storage. Keep manual exceptions explicit and audited. A human-review-ready result must not acquire automatic acceptance merely because it is named ready.

## Finish and hand off

List completed work packages and the result/evidence for every A01-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
