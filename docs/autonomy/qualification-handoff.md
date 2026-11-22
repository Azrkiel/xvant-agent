# Phase A qualification handoff

Phase A is incomplete. A03 and A04 are merged. A05 and A06 have independent
implementation drafts. A07 remains blocked on a qualified A06 execution
boundary for trusted verification and required review.

## Repository state at intake

Fetched `main` at `f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`.

| PR                                                    | State      | Base ref and SHA reported by GitHub                                        | Head SHA                                   |
| ----------------------------------------------------- | ---------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| [#15](https://github.com/Azrkiel/xvant-agent/pull/15) | Merged     | `main` · `879167d8a2960f5b756d9f2b923585c2cf32e74a`                        | `845048ab6831e25b2b44b4747bb648ba83afd3e8` |
| [#16](https://github.com/Azrkiel/xvant-agent/pull/16) | Merged     | `main` · `a8a882b2ea66ea09e9e944e3e937c8ddf2a05c1b`                        | `560c487f7d049dc3dab16b2170fdc4d9ce1c4969` |
| [#17](https://github.com/Azrkiel/xvant-agent/pull/17) | Open draft | `main` · `879167d8a2960f5b756d9f2b923585c2cf32e74a`                        | `b98d042ca9fee8bd6c5744f97f29e2d1cfdddbe5` |
| [#18](https://github.com/Azrkiel/xvant-agent/pull/18) | Open draft | `codex/a04-daemon-scheduler` · `560c487f7d049dc3dab16b2170fdc4d9ce1c4969`  | `46a8bb55082ccc569e21619fbf5ed365967189ea` |
| [#19](https://github.com/Azrkiel/xvant-agent/pull/19) | Open draft | `codex/autonomous-agent-plan` · `493ce4686b413e1e1a4ab5297b8169a33c9b9360` | `fcb693432565fc3f44e0e6a03bc0e4744d15af9d` |

A05's previous base has the same tree as current main. The three-dot
diff contained the backlog changes, so #18 was retargeted to main. A06
was reconciled directly with main, preserving A03's process-journal callback
and A06's explicit environment clearing. A05 and A06 use independent draft
schema sequences. Before combining the branches, allocate distinct migration
numbers, validate upgrade and snapshot paths from their common released base,
and retest the combined candidate.

## Earlier pinned offline evidence

| Milestone | Tested revision and prerequisite                                                                     | Review and evidence                                                                                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A00       | Roadmap merge `493ce4686b413e1e1a4ab5297b8169a33c9b9360`.                                            | Merged on the roadmap branch. All six criteria passed. The hosted Ubuntu and Windows jobs for the roadmap merge passed. [PR #10](https://github.com/Azrkiel/xvant-agent/pull/10) · [criteria](../evidence/a00/handoff.md#acceptance-results) · [hosted run](https://github.com/Azrkiel/xvant-agent/actions/runs/44861028668) |
| A01       | PR head `734482bd62620bffdad02944d9aeb7266b75d340`, base `c872e9a1f7d7e7823f44173d6d013ec34bf72779`. | Merged into main. A01-C1 through C6 passed offline. [PR #13](https://github.com/Azrkiel/xvant-agent/pull/13#acceptance-evidence)                                                                                                                                                                                             |
| A02       | PR head `7a073fa9c7ad12b7f475c9d7ce70e5e3d40bb7a4`, base `4cb78bfcd914d1b36a43453a97b7497ca919b821`. | Merged into main at `879167d8a2960f5b756d9f2b923585c2cf32e74a`. A02-C1 through C7 passed offline. [PR #14](https://github.com/Azrkiel/xvant-agent/pull/14#acceptance-evidence)                                                                                                                                               |
| A03       | Head `845048ab6831e25b2b44b4747bb648ba83afd3e8`, base `879167d8a2960f5b756d9f2b923585c2cf32e74a`.    | Merged. A03-C1 through C7 passed offline on the same head. [PR #15](https://github.com/Azrkiel/xvant-agent/pull/15#acceptance-evidence)                                                                                                                                                                                      |
| A04       | Head `560c487f7d049dc3dab16b2170fdc4d9ce1c4969`, base `845048ab6831e25b2b44b4747bb648ba83afd3e8`.    | Merged. Reproduced all 31 Linux offline stages and 1,507 tests on the tested head. [PR #16](https://github.com/Azrkiel/xvant-agent/pull/16#acceptance-evidence) · [repeat evidence](../evidence/autonomy/)                                                                                                                   |
| A05       | Head `46a8bb55082ccc569e21619fbf5ed365967189ea`, base `560c487f7d049dc3dab16b2170fdc4d9ce1c4969`.    | Work package 1 covers owner-written backlog revisions. This is the starting backlog-only qualification for the follow-up cycle. [PR #18](https://github.com/Azrkiel/xvant-agent/pull/18)                                                                                                                                     |
| A06       | Head `b98d042ca9fee8bd6c5744f97f29e2d1cfdddbe5`, base `879167d8a2960f5b756d9f2b923585c2cf32e74a`.    | Work package 1 covers an offline Bubblewrap fixture. This is the starting namespace-only qualification for the follow-up. [PR #17](https://github.com/Azrkiel/xvant-agent/pull/17)                                                                                                                                           |

## A04 remaining evidence

| Criterion                                                 | Status  | Observation or prerequisite                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [A04-C1](04-daemon-and-scheduler.md#acceptance-checklist) | Partial | The merge commit reports a physical reboot pass on the Arduino UNO Q. The raw installed-service reboot receipt, boot IDs, and command transcript were unavailable. The real process-kill fixture remains independently reproducible. |
| [A04-C2](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Offline client disconnect, reconnect and replay retained one acknowledgment and one logical planning dispatch.                                                                                                                       |
| [A04-C3](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Competing owners, takeover and stale results were exercised in offline processes.                                                                                                                                                    |
| [A04-C4](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Durable scheduler and fairness fixtures passed offline.                                                                                                                                                                              |
| [A04-C5](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Lifecycle controls and signal shutdown passed offline.                                                                                                                                                                               |
| [A04-C6](04-daemon-and-scheduler.md#acceptance-checklist) | Partial | Simulated clock jumps, suspend and boot change passed. The Arduino attempt lost USB ADB. No same-boot wake record was recovered. A supported host with a console or operator wake path remains necessary.                            |
| [A04-C7](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Idle and blocked observations met resource bounds with no extra fixture calls.                                                                                                                                                       |

The Linux cloud runner used PID 1 `tail` with Tini around each test
invocation. Its systemd user manager reported `offline` and
`/sys/power/state` was absent. Its A04 evidence is process/fixture
qualification. The [installed-service procedure](a04-host-qualification.md)
covers acknowledgment, original deadline, generation fencing and unreleased
effect reservations. A process-only rehearsal of its capture and replay
sequence verified all four behaviors, including rejection of the obsolete
endpoint token and retention of the original Git base. The existing A00
hosted jobs are evidence for their own source revision.

| A04 qualification route  | Result                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Linux offline            | Passed for the tested process and fixture scope                                    |
| Real host reboot         | Partial evidence. Arduino UNO Q pass reported at merge. Raw receipt unavailable    |
| Physical suspend         | Partial. Interrupted attempt reported at merge. Same-boot wake receipt unavailable |
| Deterministic simulation | Passed for clock jumps, boot identity change and simulated suspend                 |
| Hosted CI                | Not run                                                                            |
| Windows                  | Not run                                                                            |
| Live providers           | Not run                                                                            |

The raw host receipts were sought in the repository branches, PR #16's
conversation and review records, comments on the merge commit, and GitHub
Actions artifacts. The merge commit is the available physical-host record.
Keep it alongside the process and simulation evidence. Reproduce the
physical suspend exercise only with an approved wake path and preserve its
same-boot observations. The missing host receipts allow fixture development
on the merged A04 queue. [A04 merge record](https://github.com/Azrkiel/xvant-agent/commit/f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593)

## A06 criterion handoff

Independent draft [#17](https://github.com/Azrkiel/xvant-agent/pull/17)
at `563223d230e97aca8fdda93a40dd44dfdafc4643`, based on main at
`f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`. The follow-up adds a
bounded report export, a delegated cgroup launcher, and a durable ledger.
The offline report entry point reserves before spawn and refuses to reuse
a previous action as a new dispatch. Schema 10 introduces two additive
tables. Restore a verified pre-upgrade backup to a separate directory to
roll back. Keep the upgraded store, workspaces, and any unresolved group.

| Criterion | Status  | Observation                                                                                                                                                                                   |
| --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A06-C1    | Partial | Bubblewrap denied unrelated workspace, controller and credential sentinels, an outside link, and both host listeners. Qualified provider profiles remain open.                                |
| A06-C2    | Blocked | No approved profile, live credentials and runner for Codex, Claude or OpenCode were available.                                                                                                |
| A06-C3    | Partial | A real detached descendant stopped after the original 1,500 ms namespace deadline. Delegated CPU, memory, process and disk enforcement and restart recovery of that scope remain unqualified. |
| A06-C4    | Partial | The fenced ledger held cumulative parent, child and project allocations and refused an over-allocation and duplicate dispatch after restart. Concurrent provider dispatch was not run.        |
| A06-C5    | Partial | The full reservation stayed charged while usage was unknown and persisted after restart. No live financial cap was claimed or exercised.                                                      |
| A06-C6    | Partial | The credential sentinel did not reach the worker. The validated report path rejected unknown fields and truncated output. No provider credential, prompt or log path was exercised live.      |
| A06-C7    | Partial | Unsupported provider entry and invalid cgroup and mount configurations failed before spawn with actionable errors. Live authentication routes remain unqualified.                             |

[Commands, runner and offline evidence](../evidence/autonomy/README.md#a06-report-and-budget-follow-up)
· [Boundary and rollback](https://github.com/Azrkiel/xvant-agent/blob/563223d230e97aca8fdda93a40dd44dfdafc4643/docs/a06-worker-boundary.md)

## A07 criterion handoff

A03 is merged and its local Git and fake remote reconciliation evidence is
available. A06 still needs whole-environment qualification and an approved
execution profile for trusted verification and required review. No A07
implementation or qualification was started under the milestone dependency
rule. The pinned A07 base for this handoff is main
`f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`. There is no tested A07 SHA.
Preserve A01 manual acceptance for exact reviewed artifacts.
[A03 evidence](https://github.com/Azrkiel/xvant-agent/pull/15#acceptance-evidence)
· [A06 draft](https://github.com/Azrkiel/xvant-agent/pull/17)

| Criterion | Status          | Evidence required                                                                                                                            |
| --------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A07-C1    | Blocked         | Trusted checks and review on a qualified worker boundary, followed by an authorized promotion receipt.                                       |
| A07-C2    | Not run         | Refusal receipts for empty, weakened, stale or failed verification and rejected or missing required review.                                  |
| A07-C3    | Not run         | Move the target before promotion and record the refusal and verification of the newly combined candidate.                                    |
| A07-C4    | Not run         | Inject a crash after the Git update and exercise a lost remote reply with operation-correlated reconciliation. Verify one logical promotion. |
| A07-C5    | Blocked         | An immutable decision binds the exact candidate and target, requirements, policy, check profile and independent review.                      |
| A07-C6    | Blocked         | A06 qualification for the execution environment that carries out checks and review.                                                          |
| A07-C7    | Not run for A07 | Verify explicit manual acceptance and prove a manual exception cannot be reused for a changed revision or scope.                             |

Begin with host-owned verification profiles and immutable receipts after A06
qualifies. Preserve source trust and use a sandbox for repository tests. Reuse
the A01 completion decision and the A03 effect journal when promotion begins.
Serialize the destination update and compare against the pinned target head
at the actual effect boundary. Keep separate receipts for local Git and any
approved remote integration. [A07 subplan](07-verification-and-promotion.md)

## A07–A11 dependency gates

| Criteria                                                                         | Status  | Missing evidence or working dependency                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [A08-C1, C2, C3, C4, C5, C6](08-events-and-integrations.md#acceptance-checklist) | Blocked | Needs the qualified A04 queue, the A05 manager, and A07’s evidence-bound promotion.                                                                                                                      |
| [A08-C7](08-events-and-integrations.md#acceptance-checklist)                     | Blocked | Also needs an approved hosted disposable repository and a qualified provider integration account for the issue and PR trial.                                                                             |
| [A09-C1, C2, C3, C4, C5, C6, C7](09-memory-and-learning.md#acceptance-checklist) | Blocked | A05 has durable planning records. The manager still needs a task-packet interface and evidence-bound work admission before project-scoped retrieval and controlled lessons comparisons can be exercised. |
| [A10-C1, C2](10-operations.md#acceptance-checklist)                              | Partial | A04 exposes durable root status and generation-fenced root commands. Project-level controls and fault receipts need A04, A06 and A07.                                                                    |
| [A10-C3, C4, C5, C6, C7](10-operations.md#acceptance-checklist)                  | Blocked | Needs the supported Linux service and qualified verification/isolation paths to exercise full backup, upgrade, retention, alerting and an independent operator rehearsal.                                |
| [A11-C1, C2](11-qualification.md#acceptance-checklist)                           | Blocked | Needs a fixed A00–A10 candidate and a preregistered fault campaign. Earlier milestone fixtures supply component evidence.                                                                                |
| [A11-C3, C4](11-qualification.md#acceptance-checklist)                           | Blocked | Needs the integrated three-milestone restart demo, physical service lifecycle and approved runners for 24-hour, 72-hour and seven-day soaks.                                                             |
| [A11-C5, C6](11-qualification.md#acceptance-checklist)                           | Blocked | Needs qualified live profiles, approved accounts, frozen task allocation and repeated single-agent, orchestration and lessons comparisons.                                                               |
| [A11-C7, C8](11-qualification.md#acceptance-checklist)                           | Blocked | Needs source-bound qualification criteria and receipts before release-policy admission and installation of a published candidate.                                                                        |

Run the reference project after the manager, isolation and promotion
prerequisites are ready. Include three dependent milestones, a parallel
opportunity, a failing check and bounded repair, worker death, restart,
and a target-head change. Exercise a separate unresolvable external
effect and account for its retained reservation. After A08–A10, freeze
the release candidate and campaign configuration before starting the
A11 faults and elapsed-time soaks.
