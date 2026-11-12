# A10 — Operator experience, observability, and service lifecycle

Status: planned. Completion prerequisites: A04, A06, and A07. Read [the overall plan](README.md) first.
Build basic observability alongside A04 rather than waiting for this milestone's final acceptance.

## Outcome

An operator can understand, control, recover, and upgrade XVANT without reverse-engineering logs or mutating its database manually. A healthy unattended service still needs explicit operational procedures.

Inspect the local UI/API, CLI shell, backup/restore commands, snapshot validation, package/release scripts, and existing soak machinery. Reuse working components and replace stale documentation with observed procedures.

## Execution

1. Show project objective, milestone progress, current/next actions, routing rationale, evidence, remaining budgets, blockers, and last meaningful progress. Distinguish waiting, blocked, reconciling, failed, and completed.
2. Provide authenticated, version-checked controls for pause/resume, drain, cancel, project-policy changes, and bounded reconciliation decisions. Explain consequences before destructive actions. Preserve idempotency for repeated client requests.
3. Add structured logs, metrics, correlation IDs, retention, and redaction. Define alerts for stuck runnable work, repeated recovery, disk pressure, lease loss, unavailable providers, and growing queues. Avoid alert storms.
4. Back up SQLite and referenced artifacts consistently. Verify manifests and restore into a new directory; validate ownership and uncertain external effects before the restored service can dispatch.
5. Implement upgrade drain, version compatibility checks, schema migrations, interrupted-migration recovery, and rollback constraints. An irreversible migration needs a tested restore path, not an unsupported down-migration claim.
6. Define garbage collection for abandoned workspaces, artifacts, logs, and completed-run history. Use references/retention and ownership checks; never delete resources of an unresolved operation or another user's checkout.
7. Package installation/service configuration and document startup, auth repair, quota blocks, recovery, restore, upgrades, and uninstall/data retention. Keep host-specific instructions explicit.
8. Preserve operator audit trails for overrides, policy changes, and manual reconciliation. Acknowledgment by a human is a recorded authority decision, not fabricated technical proof.

## Success criteria

- **A10-C1:** The UI/CLI explains what is happening, why, what is proved, what is blocked, and what will happen next using durable state.
- **A10-C2:** Repeated/stale control requests cannot duplicate work or overwrite newer state.
- **A10-C3:** A backup restores to a fresh supported host with all referenced artifacts verified; unresolved external effects remain unresolved until reconciled.
- **A10-C4:** Upgrade and interrupted-migration drills preserve tasks, authority versions, and recovery information.
- **A10-C5:** Cleanup and retention do not delete active, referenced, or uncertain-operation resources.
- **A10-C6:** Logs and public evidence contain no credential values; alerts are actionable and bounded.
- **A10-C7:** A second operator can follow the documented install, pause, recovery, upgrade, and restore procedures without source-code guidance.

## Validation and latitude

Exercise browser/CLI controls, lost client responses, stale versions, concurrent policy changes, disk pressure, backup interruption, missing artifact, failed migration, and fresh-host restore. Check the actual packaged service, not only library calls.

Choose UI layout and telemetry stack to fit a local service; external monitoring is optional. Prefer clear explanations and a small action surface over a dense dashboard. Do not introduce cloud dependencies solely for charts.

## Deliverables and handoff

Operator interface, metrics/logging, packaging/service instructions, backup/restore and migration drills, and runbook. A11 consumes these for unattended qualification and final release evidence.
