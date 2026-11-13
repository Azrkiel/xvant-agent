# A10 — Operator controls and service operations

Status: planned. Completion prerequisites: **A04, A06, A07**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

An operator can understand current work, resolve specific blocks, and install, upgrade, back up, and restore the service using documented procedures.

## Start here

Inspect `apps/controller/public`, `apps/controller/src/app.ts`, `apps/controller/src/http`, `scripts/xvant.mjs`, `scripts/package-release.mjs`, `packages/storage/src/artifacts.ts`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Expose durable progress and control. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Expose durable progress and control

Show objective, next actions, routing reason, proof, budgets, blockers, and progress age. Add authenticated idempotent version-checked pause/drain/cancel/reconciliation controls.

**Deliver:** An operator view and command surface driven by stored state.

### Work package 2: Make failures diagnosable

Add correlation-aware redacted logs, bounded retention, and actionable alerts for stalled work, provider blocks, disk pressure, lease loss, and queue growth. Define safe cleanup of owned, unreferenced resources.

**Deliver:** Operational signals and resource-retention policies.

### Work package 3: Exercise the service lifecycle

Package installation; consistently back up state and artifacts; restore to a fresh host; drain/migrate/upgrade; recover interrupted migration. Document rollback constraints and unresolved effects after restore.

**Deliver:** A runbook proven by install, upgrade, and restore drills.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A10-C1:** The UI/CLI explains what is happening, why, what is proved, what is blocked, and what will happen next using durable state.
- [ ] **A10-C2:** Repeated/stale control requests cannot duplicate work or overwrite newer state.
- [ ] **A10-C3:** A backup restores to a fresh supported host with all referenced artifacts verified; unresolved external effects remain unresolved until reconciled.
- [ ] **A10-C4:** Upgrade and interrupted-migration drills preserve tasks, authority versions, and recovery information.
- [ ] **A10-C5:** Cleanup and retention do not delete active, referenced, or uncertain-operation resources.
- [ ] **A10-C6:** Logs and public evidence contain no credential values; alerts are actionable and bounded.
- [ ] **A10-C7:** A second operator can follow the documented install, pause, recovery, upgrade, and restore procedures without source-code guidance.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario                    | Setup/action                                                           | Required observation                                                      |
| --------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Repeated/stale control      | Retry a lost request and submit a control using an old state version.  | No duplicated action or overwrite of newer state occurs.                  |
| Restore/upgrade interrupted | Remove an artifact, interrupt backup/migration, and restore elsewhere. | Integrity issues are explicit; work and uncertainty retain their meaning. |
| Cleanup and visibility      | Create disk pressure and resources belonging to active/unknown work.   | Useful diagnostics appear; protected resources are not deleted.           |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Choose a clear CLI/UI and suitable local telemetry. Build basic health signals with A04. Avoid extra cloud dependencies just for dashboards, and never treat an operator acknowledgment as fabricated technical proof.

## Finish and hand off

List completed work packages and the result/evidence for every A10-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
