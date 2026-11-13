# A11 — Reliability and release qualification

Status: planned. Completion prerequisites: **A00–A10**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

Publish reproducible evidence of the supported system's recovery, unattended behavior, and usefulness relative to a single capable agent.

## Start here

Inspect `packages/evaluation`, `fixtures/benchmarks`, `scripts/soak.mjs`, `scripts/soak-live.ts`, `scripts/release-policy.ts`, `scripts/release-check.mjs`, `scripts/evidence-bundle.ts`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Freeze the campaign before running it. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Freeze the campaign before running it

Record source, environment, policy, providers, resource/progress bounds, fault schedule, task allocation, held-out split, comparison metrics, and acceptable tradeoffs. Extend existing evaluation tools incrementally.

**Deliver:** A preregistered qualification configuration and required-evidence checklist.

### Work package 2: Prove recovery and sustained operation

Run every required fault case plus the reference project, fresh-host restore/upgrade drills, and actual 24-hour, 72-hour, and seven-day soaks. Account for every operation and intervention.

**Deliver:** Source-bound reliability results, resource trends, and supported-profile evidence.

### Work package 3: Compare outcomes and qualify release

Compare one capable worker, orchestration, and isolated lessons-on/off variants with at least three initial repeats and more if inconclusive. Publish failures, uncertainty, defects, usage, elapsed time, and interventions. Make release checks fail on missing/stale mandatory evidence.

**Deliver:** A qualification report, raw outcomes, evidence index, and installable release candidate.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A11-C1:** Every mandatory fault case has source-bound evidence and an accounted-for outcome.
- [ ] **A11-C2:** The qualification campaigns observe zero lost committed tasks, duplicate logical promotions, stale-evidence acceptance, or unauthorized boundary violations; any such violation blocks qualification and requires repair plus relevant reruns.
- [ ] **A11-C3:** The staged soaks meet preregistered resource/progress bounds, and the multi-milestone restart demonstration completes.
- [ ] **A11-C4:** Backup restore, host reboot, and upgrade drills pass on the actual supported deployment profile.
- [ ] **A11-C5:** Live runtime/profile qualification records exact versions and capabilities; untested routes remain explicitly unsupported.
- [ ] **A11-C6:** Repeated baseline comparisons publish raw outcomes, uncertainty, tradeoffs, and intervention/defect measurements. Product claims do not exceed those results.
- [ ] **A11-C7:** The release policy/checker encodes mandatory evidence requirements and fails for missing, failed, incompatible, or stale qualification evidence.
- [ ] **A11-C8:** A release candidate installs from its published package, identifies its source, and provides a supported-profile matrix and actionable recovery runbook.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario               | Setup/action                                                                                                                                         | Required observation                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Mandatory fault matrix | Inject controller/worker death, lost responses, stale ownership, duplicate delivery, moved heads, outages, clock/suspend changes, and disk failures. | Every outcome is completed, safely resumable, cancelled with defined semantics, or explicitly blocked.                                        |
| Unattended lifecycle   | Observe real-time soaks and execute reboot/restore/upgrade drills.                                                                                   | Declared resource/progress bounds hold with zero observed lost tasks, duplicate logical promotions, stale acceptance, or boundary violations. |
| Fair comparison        | Use frozen tasks/acceptance with matched limits where feasible and include incomplete attempts.                                                      | Raw outcomes and uncertainty support only the claims actually made.                                                                           |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Choose representative workloads and fault tools, but set thresholds before inspecting results. Do not replace elapsed-time observation with synthetic timestamps or certify untested platforms. If benefit is not established, report that result and keep defaults/claims narrow. Any safety violation blocks qualification until repaired and revalidated.

## Finish and hand off

List completed work packages and the result/evidence for every A11-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
