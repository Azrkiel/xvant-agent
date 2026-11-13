# A00 handoff

Status: complete. Work packages 1–3 delivered; no prerequisite milestones.
[PR #10](https://github.com/Azrkiel/xvant-agent/pull/10) targets
`codex/autonomous-agent-plan`. The implementation branch is
`codex/a00-reproducible-checks-ci`. The PR remains unmerged; A01 has not begun.

## Implementation and provenance

- Plan baseline: [`71b7b4e`](https://github.com/Azrkiel/xvant-agent/commit/71b7b4e7559eaa9607a45aabcdb841faaccf404b).
- Baseline reproduction: [`3fdf146`](https://github.com/Azrkiel/xvant-agent/commit/3fdf1464f7e0b95ee2f34a26d113a6b98f91841e).
- CI, complete suite floors, source/bundle admission and fail-closed browser registration:
  [`7bb00ad`](https://github.com/Azrkiel/xvant-agent/commit/7bb00ada15cf912ed4cbcb2cd367ffa2328f0db7).
- Hosted-runner diagnosis/correction:
  [`29101ca`](https://github.com/Azrkiel/xvant-agent/commit/29101ca629fb110a864779ca6c836ec0d97160d8) and
  [`6e5fbff`](https://github.com/Azrkiel/xvant-agent/commit/6e5fbffb23c0765b2b3b8c4dd0d4d1dd41678c8a).
- Browser readiness regression/correction:
  [`b56cab6`](https://github.com/Azrkiel/xvant-agent/commit/b56cab6fc797df20693c613bc594127f0882dcbe).
- Qualified runtime/CI source:
  [`febbb5f`](https://github.com/Azrkiel/xvant-agent/commit/febbb5f17515606886c6caec91005f9b3431ec55),
  also adding the early standalone-browser preflight. Later changes are runner
  documentation, status and evidence records; final PR checks exercise the
  submitted head again.

[Runner guide](../../autonomy/a00-runner.md), [evidence index](../README.md),
[machine-readable observations](index.json), [CI jobs/artifacts](ci-jobs.json),
and [retained file checksums](SHA256SUMS). Each receipt identifies the tested
commit separately from its source content hash. Source inventories exclude
`docs/evidence/` to avoid circular evidence hashing; all other indexed and
nonignored files, including documentation, are inventoried.

## Acceptance results

| Criterion | Result     | Observed command/artifact and outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A00-C1    | **Passed** | Fresh clone/empty npm cache: `npm ci --ignore-scripts --no-audit --no-fund`, then `npm run gate -- --phase 10 --offline`. [Baseline receipt](baseline-passed.json) and [bundle](baseline-passed.tar.gz): 31 checks, 1,428 tests / 113 suites. [Clean implementation receipt](readiness-linux-local.json), [bundle](readiness-linux-local.tar.gz), [source admission](readiness-linux-local-source-validation.json): 31 checks, 1,444 tests / 115 suites. Fresh hosted Linux and Windows runners independently installed and passed below.                                                                                                                                                                                                                                                                                                        |
| A00-C2    | **Passed** | [Linux job](https://github.com/Azrkiel/xvant-agent/actions/runs/43371112543/job/131706944811), [Windows job](https://github.com/Azrkiel/xvant-agent/actions/runs/43371112543/job/131706945049), and source admissions [Linux](ci-linux-readiness-ci-summary.json) / [Windows](ci-windows-readiness-ci-summary.json) bind the actual checkout to `febbb5f17515606886c6caec91005f9b3431ec55` and the full content hash. All 31 stages and 115 required suites are admitted. [Deleted-suite run](https://github.com/Azrkiel/xvant-agent/actions/runs/43367338919) failed even though Vitest exited 0 with 1,439 passing tests; [receipt](ci-missing-suite.json) reports the missing signing suite. A [source-changed local receipt](readiness-source-changed.json) also correctly failed after 31 passing stages and is not qualification evidence. |
| A00-C3    | **Passed** | [Deliberate assertion run](https://github.com/Azrkiel/xvant-agent/actions/runs/43367338661) failed with one of 1,442 tests failing; all 31 stages ran and diagnostics uploaded. [Receipt](ci-failing-fixture.json), [bundle/stack trace](ci-failing-fixture.tar.gz). [Unavailable-browser run](https://github.com/Azrkiel/xvant-agent/actions/runs/43367338498) failed UI setup and the standalone browser with exit 2 / `status: unavailable`; [receipt](ci-missing-browser.json), [bundle](ci-missing-browser.tar.gz). Jobs were genuinely red, with no `continue-on-error` or job reruns.                                                                                                                                                                                                                                                     |
| A00-C4    | **Passed** | [Workflow](../../../.github/workflows/offline.yml): `contents: read`, `persist-credentials: false`, no secrets/provider logins, no `pull_request_target`, offline commands only. [Observed token permissions](ci-runner-permissions.log): Contents/Metadata read. Public dependency/browser downloads and GitHub's scoped artifact service require no repository write credential or real provider account.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A00-C5    | **Passed** | Independent Linux and Windows receipts below: each 31 checks / 1,444 tests, coverage passed. Tini `-s`, canonical temp storage, OpenSSH and Chromium requirements are documented and exercised. Windows uses one worker; original deadlines, SQLite durability and process-death assertions remain unchanged. Live/unattended Windows operation is not qualified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A00-C6    | **Passed** | Source/runtime/host/command/result links are retained in the index, machine index, receipts, setup logs and immutable bundles. Git-tracked archives survive 30-day Actions artifact expiry. All archive manifests and downloaded ZIP digests were verified. Raw logs/evidence bytes are preserved by Git attributes and the retained files were checked with the existing secret detector. Keys, databases, browser profiles, credentials and live transcripts are excluded.                                                                                                                                                                                                                                                                                                                                                                     |

## Independent platform qualification

Both qualified jobs tested `febbb5f17515606886c6caec91005f9b3431ec55` and source
content hash `e2c5a5bfd0bb20d5f298d126919deb52de924f0092c56d6e2687b26fc0d21127`.

| Platform                          | Observed result                                      | Durable evidence                                                                                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux / Ubuntu 24.04              | 31 checks; 1,444 tests / 115 suites; coverage passed | [Receipt](ci-linux-readiness.json), [bundle](ci-linux-readiness.tar.gz), [setup](ci-linux-readiness-setup.log), [real-browser preflight](ci-linux-readiness-browser-preflight.log)                                                                      |
| Windows Server 2025 / build 26100 | 31 checks; 1,444 tests / 115 suites; coverage passed | [Receipt](ci-windows-readiness.json), [bundle](ci-windows-readiness.tar.gz), [setup](ci-windows-readiness-setup.log), [real-browser preflight](ci-windows-readiness-browser-preflight.log), [journal probe](ci-windows-readiness-journal-preflight.log) |

Pinned runtime on both hosted platforms: Node **24.21.0**, npm **12.0.2**,
SQLite **3.53.4**, and locked Playwright Chromium **153.0.8010.12**.
Linux Git was **2.56.0**; Windows Git **2.56.0.windows.4**. Linux uses Tini
**0.19.0**; Windows uses its native process supervision. Exact OpenSSH, browser,
OS and host details remain in each receipt/setup log. Linux coverage: lines
**95.49%**, branches **89.39%**; Windows: lines **95.52%**, branches **89.66%**.
Function/statement and per-file thresholds also passed; see bundled summaries.

The independent [Windows push job](https://github.com/Azrkiel/xvant-agent/actions/runs/43371106442/job/131706922445)
also passed 31 checks / 1,444 tests: [receipt](ci-windows-readiness-repeat.json),
[bundle](ci-windows-readiness-repeat.tar.gz), [source admission](ci-windows-readiness-repeat-ci-summary.json).
Both complete push and PR runs passed on both platforms; their metadata is
retained in `ci-jobs.json`. Neither was a rerun of a failed job.

The local baseline was Debian 13.6, Node 24.21.0, npm 12.0.2, SQLite 3.53.4,
Chromium 156.0.8078.79, OpenSSH 10.0p2 and Tini 0.19.0; see
[host record](baseline-host.json). It used a fresh checkout/cache on the recorded
cloud host, not a newly provisioned VM. Hosted CI independently supplies fresh
runners and records each host. Fixture results never establish live provider,
subscription, hostile-code containment, or unattended-operation readiness.

## Failures, diagnosis and evidence limits

- Initial Linux browser launch failed because the Chromium sandbox helper was
  owned by `nobody` and user namespaces were unavailable. [Failed receipt](baseline-browser-failed.json),
  [launch diagnostic](baseline-browser-launch.log), and [bundle](baseline-browser-failed.tar.gz).
  A documented ephemeral `--no-sandbox` launcher is limited to trusted local
  fixtures, matching Playwright's Linux fixture setting. Allowed-origin,
  denied-request, screenshot, profile cleanup and child cleanup checks stay required.
- Initial Windows setup failed 87 tests. [Receipt](ci-windows-initial-failed.json)
  and [path probe](ci-windows-path-diagnostic.json) show Node preserving `RUNNER~1`
  while Git expanded it to `runneradmin`, breaking strict root/scope comparisons.
  CI uses canonical `RUNNER_TEMP/xvant-fixtures` for `TEMP`, `TMP` and `TMPDIR`,
  outside the checkout. One Windows worker reduces durable-I/O contention.
  The 4,096-frame limit, `synchronous=FULL`, original 15-second journal deadline
  and process-death assertions did not change.
- The parallel Windows push for `6e5fbff` [failed its browser check](https://github.com/Azrkiel/xvant-agent/actions/runs/43368639732/job/131699032575)
  although its 1,441 tests and the PR job passed. [Receipt](ci-windows-browser-failed.json)
  and [bundle](ci-windows-browser-failed.tar.gz) remain retained. Its original
  generic `TOOL_FAILED` output does not establish the exact failed startup boundary.
  A delayed-page regression then reproduced a concrete readiness defect in the
  original code: [red result](browser-readiness-before.log). The correction waits
  for the initial DevTools page within the existing launch deadline, without
  relaunching a browser or repeating navigation. Protocol errors and timeout/
  cleanup still fail. The fixture now records a bounded, redacted underlying error.
  Subsequent qualification is bound to the corrected source, not inferred from
  the earlier green job. The historical discarded exception cannot be recovered.
- A local run was invalidated because its workflow source changed while checks
  were running. It passed 31 stages / 1,444 tests, then correctly failed with
  `Source changed during verification`; [receipt](readiness-source-changed.json),
  [bundle](readiness-source-changed.tar.gz), [log](readiness-source-changed.log).
  The separate frozen-commit local run passed. No invalidated receipt was admitted.

Negative proofs are separate Linux-only commits based on `7bb00ad`, never merged
into the implementation branch. Retained patches reproduce the exact mutations:
[assertion](proof-failing-fixture.patch), [browser](proof-missing-browser.patch),
[deleted suite](proof-missing-suite.patch). Their source hashes differ by design.
These unchanged failure paths remain distinct from the corrected source's positive
qualification. Complete bundle integrity means preserved bytes, not passing tests.
The browser-negative run has no coverage summary because its UI hook failed;
the missing-suite run retains passing test JSON/coverage but fails gate admission.

## Design, interfaces, migration and rollback

The original gate, coverage thresholds, process-death checks and ownership/policy
assertions remain. Suite floors were raised to the observed baseline and ten
previously omitted existing suites were made required. New regressions add sixteen
test cases. Every checked-in test suite is required by phase 10. `ci-policy.ts`
admits the complete 31-stage roster, source identity, suite counts and structured
artifacts. Intentionally added tests/stages need their required manifests updated
in the same reviewed change.

The gate clears stale test/coverage/manifest outputs, snapshots source before
checks, and archives available structured diagnostics even on failure. CI checks
a clean source checkout, validates the exact immutable bundle, runs read-only
preflights, retains allowlisted outputs on failure, and bounds job/stage execution.
There is no mutable project-state cache. Evidence is an observation, not product
permission or autonomous acceptance.

An explicitly set `XVANT_BROWSER` is now authoritative, including empty/missing
registrations. Unset it to restore system discovery. Browser startup now waits
for actual page readiness within the original deadline. Product path/symlink
checks and persisted lesson identities were preserved; the runner satisfies their
strict existing contract instead of changing their meaning.

No state/schema/database migration is required. Rollback by reverting the
milestone implementation/docs commits or keeping the branch unmerged. Keep
historical evidence labeled as such. No live account, production service, or
stored user data was changed.

## Remaining limitations and next task

Live providers/models/accounts, unattended Windows operation, hostile worker/
browser isolation, durable daemon/resume/integration behavior and long release
fault campaigns are **not run / not qualified**. Installation needs public
network access; offline fixture verification is not an air-gapped install claim.
Hosted OS packages/images can change; receipts record observed versions. The
browser launcher is for trusted fixtures and does not supply a production sandbox.
Finite observed passes do not establish universal absence of startup failures.

Actions artifacts expire after 30 days. Use the repository archives/checksums for
durable evidence, and promote future qualifying receipts before expiry. Temporary
databases, keys and profiles are deliberately excluded. The separately authorized
live qualification route is in the runner guide and was not executed for A00.

Next useful task, after A00 review/merge and a separately assigned request:
**A01 — Project and completion contracts**, starting with its first work package.
This handoff does not begin A01 or authorize merging this PR.
