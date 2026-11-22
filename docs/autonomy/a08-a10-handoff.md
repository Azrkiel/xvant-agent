# A08–A10 qualification handoff

Current main is `f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`.
The roadmap was read at `493ce4686b413e1e1a4ab5297b8169a33c9b9360`.
PR #19 advanced from `fcb693432565fc3f44e0e6a03bc0e4744d15af9d`
to `4a917ca55986c39e48a31df100429c3877cbe553` during this work.
Both revisions still have their original evidence. The latest
[prerequisite handoff](qualification-handoff.md) records the current A05
and A06 qualification and the missing A04 host receipts.

## Verified prerequisites

| Milestone | Tested source and base                                                                               | Current state and evidence                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A00       | Roadmap merge `493ce4686b413e1e1a4ab5297b8169a33c9b9360`                                             | Ubuntu 24.04 and Windows 2025 passed for that source. The hosted workflow is on the roadmap branch. [Hosted result](https://github.com/Azrkiel/xvant-agent/actions/runs/44861028668)                                                                                                                                                                                                                                                    |
| A01       | `734482bd62620bffdad02944d9aeb7266b75d340` on `c872e9a1f7d7e7823f44173d6d013ec34bf72779`             | Merged into main. C1–C6 passed offline. [PR #13](https://github.com/Azrkiel/xvant-agent/pull/13#acceptance-evidence)                                                                                                                                                                                                                                                                                                                    |
| A03       | `845048ab6831e25b2b44b4747bb648ba83afd3e8` on `879167d8a2960f5b756d9f2b923585c2cf32e74a`             | Merged into main. C1–C7 passed offline, including a loopback lost-response case. [PR #15](https://github.com/Azrkiel/xvant-agent/pull/15#acceptance-evidence)                                                                                                                                                                                                                                                                           |
| A04       | `560c487f7d049dc3dab16b2170fdc4d9ce1c4969` revalidated on `a8a882b2ea66ea09e9e944e3e937c8ddf2a05c1b` | Merged. C2–C5 and C7 passed offline. The merge reports a physical reboot pass on Arduino UNO Q. The raw reboot receipt remains unavailable, so C1 host evidence is partial. C6 remains partial after USB ADB disconnected during the suspend attempt. [Merge record](https://github.com/Azrkiel/xvant-agent/commit/f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593) · [A04 criterion handoff](qualification-handoff.md#a04-remaining-evidence) |
| A05       | `e97d719fef88eeea19c49f8d67124105063d3de4` on main `f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`        | Draft #18. All 219 focused tests and 31 gate stages passed with 1,513 tests on the current head. C2, C5 and C6 passed offline. C1, C3, C4 and C7 remain partial. [PR #18](https://github.com/Azrkiel/xvant-agent/pull/18) · [Source-bound evidence](../evidence/autonomy/README.md#a05-manager-follow-up)                                                                                                                               |
| A06       | `563223d230e97aca8fdda93a40dd44dfdafc4643` on main `f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`        | Draft #17. All 195 focused tests, the namespace and report fixture, and all 31 gate stages passed with 1,509 tests. C2 remains blocked on an approved live profile. C1 and C3–C7 remain partial. [PR #17](https://github.com/Azrkiel/xvant-agent/pull/17) · [Source-bound evidence](../evidence/autonomy/README.md#a06-report-and-budget-follow-up)                                                                                     |
| A07       | No implementation ref or tested source found                                                         | A06 qualification blocks A07. C1, C5 and C6 are blocked. C2–C4 and C7 were not run for A07. [Criterion handoff](qualification-handoff.md#a07-criterion-handoff)                                                                                                                                                                                                                                                                         |

Running `sha256sum -c SHA256SUMS` verified all six prerequisite
receipt bundles under [Phase A offline validation](../evidence/autonomy/README.md).
That includes the current A05 and A06 heads and the earlier A05 failed
gate at `30c4d100b94dffb5e9bcc5164db5bc6e294ef832`. The current A05
archive also preserves the first focused run before its schema 11
snapshot correction.

## Inputs still required for A11

1. Attach the missing A04 reboot receipt or repeat the drill. Finish
   physical suspend on a supported Linux host with an independent way
   to observe wake. Qualify the A05 manager, A06 live
   profiles and budgets, and A07 evidence-bound promotion. Resolve the
   parallel SQLite migrations when combining A05 and A06. Both drafts
   assign schema 10 to different tables. Rehearse upgrades from each
   supported deployed schema with verified backups. Run the
   three-milestone restart demonstration on the integrated source.
2. Finish A08 polling, timers, causality and remote reconciliation. Use an
   approved disposable GitHub repository and a qualified integration
   account for the issue-to-task and verified-candidate-to-PR trial.
   Capture a single PR after deliberately losing the acknowledgment.
3. Extend A09 to anchored manager packets and structured external-runtime
   search. Freeze task allocation, limits, and independent store seeds before
   repeating the lessons-on/off comparison with live profiles.
4. Complete the A10 installed-service exercise on a fresh supported host,
   including verified restore, interrupted upgrade, live retention
   protection and an independent operator walkthrough. Capture bounded
   alert and credential-redaction evidence.
5. Freeze a single reviewed release candidate and a preregistered fault
   matrix. Re-run source-bound hosted Linux and Windows checks where
   supported. Qualify the intended live profile and publication path
   against that source. The elapsed-time soaks belong to A11.

[Release qualification subplan](11-qualification.md)
