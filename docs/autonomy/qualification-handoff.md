# Phase A qualification handoff

Phase A is incomplete. The A03 recovery and A04 daemon changes are open
drafts. A04 has repeatable Linux offline evidence and still needs a
disposable host approved for service-managed reboot and physical suspend.
A05 has a durable backlog. A06 has an offline Linux worker boundary.

## Baseline and draft stack

| Milestone | Tested revision and prerequisite                                                                     | Review and evidence                                                                                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A00       | Roadmap merge `493ce4686b413e1e1a4ab5297b8169a33c9b9360`.                                            | Merged on the roadmap branch. All six criteria passed. The hosted Ubuntu and Windows jobs for the roadmap merge passed. [PR #10](https://github.com/Azrkiel/xvant-agent/pull/10) · [criteria](../evidence/a00/handoff.md#acceptance-results) · [hosted run](https://github.com/Azrkiel/xvant-agent/actions/runs/44861028668) |
| A01       | PR head `734482bd62620bffdad02944d9aeb7266b75d340`, base `c872e9a1f7d7e7823f44173d6d013ec34bf72779`. | Merged into main. A01-C1 through C6 passed offline. [PR #13](https://github.com/Azrkiel/xvant-agent/pull/13#acceptance-evidence)                                                                                                                                                                                             |
| A02       | PR head `7a073fa9c7ad12b7f475c9d7ce70e5e3d40bb7a4`, base `4cb78bfcd914d1b36a43453a97b7497ca919b821`. | Merged into main at `879167d8a2960f5b756d9f2b923585c2cf32e74a`. A02-C1 through C7 passed offline. [PR #14](https://github.com/Azrkiel/xvant-agent/pull/14#acceptance-evidence)                                                                                                                                               |
| A03       | Head `845048ab6831e25b2b44b4747bb648ba83afd3e8`, base `879167d8a2960f5b756d9f2b923585c2cf32e74a`.    | Open draft. A03-C1 through C7 passed offline on the same head. [PR #15](https://github.com/Azrkiel/xvant-agent/pull/15#acceptance-evidence)                                                                                                                                                                                  |
| A04       | Head `560c487f7d049dc3dab16b2170fdc4d9ce1c4969`, base `845048ab6831e25b2b44b4747bb648ba83afd3e8`.    | Open draft stacked on A03. Reproduced all 31 Linux offline stages and 1,507 tests. [PR #16](https://github.com/Azrkiel/xvant-agent/pull/16#acceptance-evidence) · [repeat evidence](../evidence/autonomy/)                                                                                                                   |
| A05       | Head `46a8bb55082ccc569e21619fbf5ed365967189ea`, base `560c487f7d049dc3dab16b2170fdc4d9ce1c4969`.    | Work package 1 covers owner-written backlog revisions. The manager cycle and restart/integration demonstration await A04 and the subsequent isolation and promotion work. [PR #18](https://github.com/Azrkiel/xvant-agent/pull/18)                                                                                           |
| A06       | Head `b98d042ca9fee8bd6c5744f97f29e2d1cfdddbe5`, base `879167d8a2960f5b756d9f2b923585c2cf32e74a`.    | Work package 1 covers an offline Bubblewrap fixture. Provider profiles, whole-environment limits and durable budgets are still open. [PR #17](https://github.com/Azrkiel/xvant-agent/pull/17)                                                                                                                                |

A03 was still open when the stack was checked. After A03 merges, fetch
current main, reconcile the A04 commit against the actual merge result,
inspect the A04-only diff against main, and retarget draft #16. Re-run
affected evidence against the retargeted head and base. A05 remains based
on A04 while both drafts are open.

## A04 remaining evidence

| Criterion                                                 | Status  | Observation or prerequisite                                                                                                                                                               |
| --------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [A04-C1](04-daemon-and-scheduler.md#acceptance-checklist) | Partial | The real process-kill fixture passed. Installed-service reboot is blocked on access to an approved disposable Linux host with persistent local storage and a usable systemd user manager. |
| [A04-C2](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Offline client disconnect, reconnect and replay retained one acknowledgment and one logical planning dispatch.                                                                            |
| [A04-C3](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Competing owners, takeover and stale results were exercised in offline processes.                                                                                                         |
| [A04-C4](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Durable scheduler and fairness fixtures passed offline.                                                                                                                                   |
| [A04-C5](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Lifecycle controls and signal shutdown passed offline.                                                                                                                                    |
| [A04-C6](04-daemon-and-scheduler.md#acceptance-checklist) | Partial | Simulated clock jumps, suspend and boot change passed. Physical suspend is blocked on a supported host and operator or console wake path.                                                 |
| [A04-C7](04-daemon-and-scheduler.md#acceptance-checklist) | Passed  | Idle and blocked observations met resource bounds with no extra fixture calls.                                                                                                            |

The Linux cloud runner used PID 1 `tail` with Tini around each test
invocation. Its systemd user manager reported `offline` and
`/sys/power/state` was absent. Its A04 evidence is process/fixture
qualification. The [installed-service procedure](a04-host-qualification.md)
covers acknowledgment, original deadline, generation fencing and unreleased
effect reservations. A process-only rehearsal of its capture and replay
sequence verified all four behaviors, including rejection of the obsolete
endpoint token and retention of the original Git base. The existing A00
hosted jobs are evidence for their own source revision.

| A04 qualification route  | Result                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| Linux offline            | Passed for the tested process and fixture scope                    |
| Real host reboot         | Blocked on approved host access                                    |
| Physical suspend         | Blocked on supported suspend hardware and a wake path              |
| Deterministic simulation | Passed for clock jumps, boot identity change and simulated suspend |
| Hosted CI                | Not run                                                            |
| Windows                  | Not run                                                            |
| Live providers           | Not run                                                            |

## A07–A11 dependency gates

| Criteria                                                                                | Status  | Missing evidence or working dependency                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [A07-C1, C2, C3, C4, C5, C6, C7](07-verification-and-promotion.md#acceptance-checklist) | Blocked | A06 must qualify the execution boundary used by verification and review. The A01 acceptance decisions and A03 effect journal exist, while the A07 trusted verification profiles, serialized promotion and target-head invalidation campaign remain unrun. |
| [A08-C1, C2, C3, C4, C5, C6](08-events-and-integrations.md#acceptance-checklist)        | Blocked | Needs the qualified A04 queue, the A05 manager, and A07’s evidence-bound promotion.                                                                                                                                                                       |
| [A08-C7](08-events-and-integrations.md#acceptance-checklist)                            | Blocked | Also needs an approved hosted disposable repository and a qualified provider integration account for the issue and PR trial.                                                                                                                              |
| [A09-C1, C2, C3, C4, C5, C6, C7](09-memory-and-learning.md#acceptance-checklist)        | Blocked | A05 has durable planning records. The manager still needs a task-packet interface and evidence-bound work admission before project-scoped retrieval and controlled lessons comparisons can be exercised.                                                  |
| [A10-C1, C2](10-operations.md#acceptance-checklist)                                     | Partial | A04 exposes durable root status and generation-fenced root commands. Project-level controls and fault receipts need A04, A06 and A07.                                                                                                                     |
| [A10-C3, C4, C5, C6, C7](10-operations.md#acceptance-checklist)                         | Blocked | Needs the supported Linux service and qualified verification/isolation paths to exercise full backup, upgrade, retention, alerting and an independent operator rehearsal.                                                                                 |
| [A11-C1, C2](11-qualification.md#acceptance-checklist)                                  | Blocked | Needs a fixed A00–A10 candidate and a preregistered fault campaign. Earlier milestone fixtures supply component evidence.                                                                                                                                 |
| [A11-C3, C4](11-qualification.md#acceptance-checklist)                                  | Blocked | Needs the integrated three-milestone restart demo, physical service lifecycle and approved runners for 24-hour, 72-hour and seven-day soaks.                                                                                                              |
| [A11-C5, C6](11-qualification.md#acceptance-checklist)                                  | Blocked | Needs qualified live profiles, approved accounts, frozen task allocation and repeated single-agent, orchestration and lessons comparisons.                                                                                                                |
| [A11-C7, C8](11-qualification.md#acceptance-checklist)                                  | Blocked | Needs source-bound qualification criteria and receipts before release-policy admission and installation of a published candidate.                                                                                                                         |

Run the reference project after the manager, isolation and promotion
prerequisites are ready. Include three dependent milestones, a parallel
opportunity, a failing check and bounded repair, worker death, restart,
and a target-head change. Exercise a separate unresolvable external
effect and account for its retained reservation. After A08–A10, freeze
the release candidate and campaign configuration before starting the
A11 faults and elapsed-time soaks.
