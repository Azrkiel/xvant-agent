# A08–A10 qualification handoff

Current main is `f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`.
The roadmap was read at `493ce4686b413e1e1a4ab5297b8169a33c9b9360`.
The [original handoff](https://github.com/Azrkiel/xvant-agent/pull/19) is a
draft at `fcb693432565fc3f44e0e6a03bc0e4744d15af9d`. Its observed test
results remain valid for the archived revisions. Its prerequisite PR
states predate the A03 and A04 merges.

## Verified prerequisites

| Milestone | Tested source and base                                                                                                                                                                        | Current state and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A00       | Roadmap merge `493ce4686b413e1e1a4ab5297b8169a33c9b9360`                                                                                                                                      | Ubuntu 24.04 and Windows 2025 passed for that source. The hosted workflow is on the roadmap branch. [Hosted result](https://github.com/Azrkiel/xvant-agent/actions/runs/44861028668)                                                                                                                                                                                                                                                                                                                                                                 |
| A01       | `734482bd62620bffdad02944d9aeb7266b75d340` on `c872e9a1f7d7e7823f44173d6d013ec34bf72779`                                                                                                      | Merged into main. C1–C6 passed offline. [PR #13](https://github.com/Azrkiel/xvant-agent/pull/13#acceptance-evidence)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A03       | `845048ab6831e25b2b44b4747bb648ba83afd3e8` on `879167d8a2960f5b756d9f2b923585c2cf32e74a`                                                                                                      | Merged into main. C1–C7 passed offline, including a loopback lost-response case. [PR #15](https://github.com/Azrkiel/xvant-agent/pull/15#acceptance-evidence)                                                                                                                                                                                                                                                                                                                                                                                        |
| A04       | `560c487f7d049dc3dab16b2170fdc4d9ce1c4969` revalidated on `a8a882b2ea66ea09e9e944e3e937c8ddf2a05c1b`                                                                                          | Merged into main. C2–C5 and C7 passed offline. The merge records C1 passing on Arduino UNO Q after physical reboot. C6 remains partial after USB ADB disconnected during the suspend attempt. [PR #16](https://github.com/Azrkiel/xvant-agent/pull/16) · [Merge record](https://github.com/Azrkiel/xvant-agent/commit/f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593)                                                                                                                                                                                      |
| A05       | Historical pass at `46a8bb55082ccc569e21619fbf5ed365967189ea` on `560c487f7d049dc3dab16b2170fdc4d9ce1c4969`. Current draft head `e97d719fef88eeea19c49f8d67124105063d3de4` on main.           | Draft #18 now includes the owner-authorized offline manager, bounded repair, restart, and changed-target fixture. Its archived standalone gate applies to the earlier backlog-only head. The updated manager fixture was exercised on the A09 stack. Automatic replan, isolation and promotion qualification remain open. [PR #18](https://github.com/Azrkiel/xvant-agent/pull/18) · [Updated manager guide](https://github.com/Azrkiel/xvant-agent/blob/e97d719fef88eeea19c49f8d67124105063d3de4/docs/a05-project-backlog.md#offline-manager-cycle) |
| A06       | Historical pass at `b98d042ca9fee8bd6c5744f97f29e2d1cfdddbe5` on `879167d8a2960f5b756d9f2b923585c2cf32e74a`. Current draft head `563223d230e97aca8fdda93a40dd44dfdafc4643` incorporates main. | Draft #17 now includes durable offline budgets, cgroup limit wiring and report export. Its archived standalone namespace and gate receipts apply to the prior launcher-only head. The current guide still requires approved live profiles, accounts, and delegated cgroup qualification. [PR #17](https://github.com/Azrkiel/xvant-agent/pull/17) · [Budget and export scope](https://github.com/Azrkiel/xvant-agent/blob/563223d230e97aca8fdda93a40dd44dfdafc4643/docs/a06-worker-boundary.md#resource-reservation-and-report-export)               |
| A07       | No implementation ref or tested source found                                                                                                                                                  | C1–C7 are blocked pending the qualified A06 route and A07 profiles, acceptance and promotion. [Subplan](07-verification-and-promotion.md)                                                                                                                                                                                                                                                                                                                                                                                                            |

Running `sha256sum -c SHA256SUMS` verified all four prerequisite
receipt bundles under [Phase A offline validation](../evidence/autonomy/README.md).
The failing A05 receipt at `30c4d100b94dffb5e9bcc5164db5bc6e294ef832`
remains available alongside the corrected result. It showed a schema 10
snapshot compatibility gap.

## Inputs still required for A11

1. Finish A04's physical suspend with a supported Linux host and an
   independent way to observe wake. Qualify the A05 manager, A06 live
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
