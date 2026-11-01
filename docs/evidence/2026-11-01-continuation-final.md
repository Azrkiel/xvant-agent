# XVANT continuation — completed 2026-11-01

## Landed

- PR #1: https://github.com/Azrkiel/xvant-agent/pull/1 — merged into `codex/phase-5-tools` as `eb4efc10eb3215f212f120194d17cf2ce0ab624e`.
- Published `main`: `e5f8aa06e862d3dff6daac1d22da238d021a3613`. GitHub's main ref and `git ls-remote` both matched that exact commit after push.
- Main's shipping files match the verified feature branch. `docs/` and `.Codex/handoffs/` were removed only from the main candidate; its Git index contains neither. Four merge conflicts were documentation-only and were resolved by the required removal.
- No force push, default promotion, persistent power-policy change, or automatic paid API fallback was performed.

## Qualification

Qualified feature-source fingerprint:
`2dd7fad8e6b1dad9c6324ad3ef2d3899dcee452a99b7e5e98b0038848007f791`

- `G10-20261101T173912657Z-2dd7fad8e6b1`: passed, complete, hashes verified against the source before landing.
- **1,314 passed / 109 files; 0 failed, 0 pending.** Statements 94.14%, branches 89.73%, functions 96.90%, lines 95.43%. Test and coverage thresholds were not relaxed.
- All additional offline gate fixtures passed.
- `P10-soak-live-20261101T175136266Z-2dd7fad8e6b1`: passed, 13 iterations, seed 20261008, no invariant problems. Two real integration conflicts resolved to ready. Both cancellation iterations settled cleanly. Claude 2.1.316 / subscription Haiku was used.
- `release:check --profile local-v1`: ready before publication. Linux remains deferred.
- Focused independent reviews are retained in `docs/evidence/reviews/2026-11-01/`. The broad review findings, first failures, both timed-out full gates, diagnostic trials, and successful receipts all remain preserved; failed runs were not reclassified.

## Clean main installation

`P10-clean-install-20261101T180827379Z-c7a7bc1dea59`: passed; complete bundle and hashes verified before main push.

- Tested exact main commit `e5f8aa06e862d3dff6daac1d22da238d021a3613` from `HEAD`.
- Main source fingerprint: `c7a7bc1dea591be89a74b112df7f44304fe46958b907398d47c276b37cf8aabd`. It intentionally differs from the feature fingerprint because main excludes docs and handoffs. Shipping-source parity was checked separately.
- Fresh checkout and fresh `node_modules`: `npm ci`, typecheck, runtime discovery, empty-home status, state seeding, backup, restore, and restored-state verification all passed.
- `docsInClone: false`; Node v24.21.0, npm 12.0.2.
- Scope: same Windows host, Node/Git and npm cache; **not a fresh machine**, not login qualification, and not an upgrade/rollback test. The install needs network access for dependencies/native binaries.

Runtime discovery during that real clean-install run:

| Runtime | Version | Result |
|---|---|---|
| Codex | 0.165.0 | `version_mismatch` — not admitted |
| Claude | 2.1.316 | qualified |
| OpenCode | 2.0.19 | qualified |

## Fixes and safeguards

The reviewed work fixes unsuccessful-review authority, account/model refusal propagation, accepted-only immutable shell merges, TTY Git arguments, one-shot sharing exit status, and staged/oversized credential exclusions. The Windows cancellation race was reproduced: a failed `taskkill` helper could precede confirmed owned-process close. Windows now waits for that close within the **unchanged** shutdown deadline. No close still yields unknown and retains ownership. This is trusted-local Windows supervision, not hostile containment; Linux is not qualified.

Tandem is opt-in. No default was promoted. Admitting Codex 0.165.0 still requires the native protocol/version qualification work; do not loosen guards merely because it is newer. No new desktop/browser UI qualification was performed in this continuation.

## Environment finding

System-only execution-state requests were accepted but did not prevent Modern Standby on battery. Native System logs recorded idle/lid transitions during interrupted attempts. The operator then connected AC and explicitly approved temporary display wake requests. AC was verified, both system/display requests were accepted, and the prior state was restored after each successful long phase. No persistent power settings changed. Future long local runs need live power-state checks, AC, and the lid kept open; an accepted API request alone is not an awake guarantee.

## Preserved work and next context

- Original worktree: `C:\Users\jiang\Downloads\xvant\xvant-agent`, branch `codex/phase-5-tools`, fast-forwarded to the merged feature work.
- Both untracked Muse files were checked against saved SHA-256 values before and after the fast-forward; contents matched exactly. They remain untracked. Proof is retained under `diagnostics/2026-11-01-cancel-close/muse-preservation.json`.
- Qualified clean feature worktree: `C:\Users\jiang\xt`. Main integration worktree: `C:\Users\jiang\xm`, local branch `main-merge-tmp`. The original worktree's extra untracked Muse files mean its whole-worktree fingerprint is not the clean qualification fingerprint; do not remove them to force a match.
- The immutable source handoff remains `.Codex/handoffs/2026-11-01-continuation.md`; final results are recorded here under evidence so qualification is not invalidated by a post-gate source edit.
- Benchmark investigation: `2026-11-01-strkit-diagnosis.md`. The `write-strkit-tests` failures are real missed mutation cases, not harness false failures. The limiter failure remains a failed interrupted run. Frozen v2 fixtures, campaign records and scores were not changed. No additional v2 campaign or default-promotion repeats were run.
