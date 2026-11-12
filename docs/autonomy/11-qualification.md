# A11 — Reliability, usefulness, and release qualification

Status: planned. Completion prerequisites: A00–A10. Read [the overall plan](README.md) first.
Build the fault fixtures and measurement harness incrementally as earlier milestones land.

## Outcome

Demonstrate that the declared supported profile stays correct through failures, makes bounded autonomous progress, and provides useful results compared with a single capable agent. Publish both favorable and unfavorable outcomes.

Inspect `packages/evaluation`, frozen benchmark suites, `scripts/soak.mjs`, `scripts/soak-live.ts`, `scripts/release-policy.ts`, `scripts/release-check.mjs`, and evidence archival. Extend these instead of creating unrelated reporting machinery. Existing offline G10 is necessary baseline evidence, not unattended qualification.

## Reliability campaign

1. Freeze source, policy, environment, providers, limits, and fault schedule before the campaign. Record every injected fault and expected safe response.
2. Cover controller/worker death; before/after intent, dispatch, result and acceptance persistence; Git commit/database gap; remote acknowledgment loss; lease takeover; duplicate results/events; target-head change; network/auth/quota outage; clock jump/suspend; disk pressure; backup/restore; interrupted upgrade.
3. Account for every task/effect as completed, safely resumable, cancelled with established semantics, or explicitly blocked with evidence. Record recovery time and intervention.
4. Stage 24-hour, 72-hour, and seven-day unattended soaks on the supported deployment profile. Resource trends and queue progress must remain bounded under the declared workload. A finite soak establishes observed reliability, not universal correctness.
5. Run the overall plan's reference project demonstration, including a case that must block on ambiguity. Detect unsafe completion as a failure, even if the final code looks plausible.

## Usefulness campaign

Compare a single capable worker, XVANT orchestration, and controlled lessons-on/off variants. Use the same frozen task distribution and acceptance evaluator, matched resource limits where feasible, and record unavoidable differences. Include larger multi-file tasks and multi-milestone projects, not only tiny edits.

Before looking at outcomes, register configurations, repeated-run count, task allocation, held-out split, primary metric, and allowable tradeoffs. Use at least three repeats for the initial comparison; report uncertainty and expand the sample if it cannot support a conclusion. Lessons experiments need isolated stores or deliberate seeding to avoid cross-condition contamination.

Report accepted completion rate, independently assessed escaped defects, wall time, tokens/known spend with missing-usage labels, operator interventions per completed task, recovery time, and blocked/abandoned work. Count missing and incomplete attempts transparently; do not cherry-pick reruns or hide expensive failures.

For an unattended-efficiency claim, require lower interventions per accepted task than the chosen baseline with no unacceptable regression in completion/defects under the preregistered margins. If the data does not establish benefit, publish that conclusion and keep claims/profile defaults narrow. A safe single-worker route can remain the best routing choice.

## Success criteria

- **A11-C1:** Every mandatory fault case has source-bound evidence and an accounted-for outcome.
- **A11-C2:** The qualification campaigns observe zero lost committed tasks, duplicate logical promotions, stale-evidence acceptance, or unauthorized boundary violations; any such violation blocks qualification and requires repair plus relevant reruns.
- **A11-C3:** The staged soaks meet preregistered resource/progress bounds, and the multi-milestone restart demonstration completes.
- **A11-C4:** Backup restore, host reboot, and upgrade drills pass on the actual supported deployment profile.
- **A11-C5:** Live runtime/profile qualification records exact versions and capabilities; untested routes remain explicitly unsupported.
- **A11-C6:** Repeated baseline comparisons publish raw outcomes, uncertainty, tradeoffs, and intervention/defect measurements. Product claims do not exceed those results.
- **A11-C7:** The release policy/checker encodes mandatory evidence requirements and fails for missing, failed, incompatible, or stale qualification evidence.
- **A11-C8:** A release candidate installs from its published package, identifies its source, and provides a supported-profile matrix and actionable recovery runbook.

## Deliverables, latitude, and release decision

Publish a qualification report, reproducible commands/configurations, source-bound evidence index, supported-profile matrix, benchmark report, release-check changes, and remaining limitations. Keep secrets/user data out of public artifacts.

Choose representative tasks and fault injection machinery, but freeze success thresholds before evaluation. Explain any campaign changes and rerun affected comparisons. Do not replace long-duration observation with synthetic timestamps. Do not certify platforms or providers from a different platform's pass.

Release a narrow profile when its safety/recovery requirements pass and its capability claims match measured usefulness. Broader autonomy, new providers, or deployment authority require explicit additional qualification. Final publication/merge follows the authority actually granted by the owner; this plan itself does not grant credentials, spending, or deployment access.
