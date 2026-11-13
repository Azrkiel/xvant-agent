# A00 handoff

Status: in progress. Browser readiness follow-up is awaiting fresh CI. No prerequisite milestones.
The PR targets `codex/autonomous-agent-plan` and must remain unmerged for owner
review. A01 has not begun.

## Implementation and provenance

- Plan baseline: [`71b7b4e`](https://github.com/Azrkiel/xvant-agent/commit/71b7b4e7559eaa9607a45aabcdb841faaccf404b).
- Work package 1: [`3fdf146`](https://github.com/Azrkiel/xvant-agent/commit/3fdf1464f7e0b95ee2f34a26d113a6b98f91841e),
  clean clone/install, runner diagnosis, full baseline gate and preserved receipts.
- Work package 2: [`7bb00ad`](https://github.com/Azrkiel/xvant-agent/commit/7bb00ada15cf912ed4cbcb2cd367ffa2328f0db7),
  CI, source/bundle admission, fail-closed browser selection, complete suite floors,
  and failed-run artifacts.
- Runner diagnosis: [`29101ca`](https://github.com/Azrkiel/xvant-agent/commit/29101ca629fb110a864779ca6c836ec0d97160d8),
  retained Git/Node identity preflight; Windows failed early with its path spellings.
- Runner correction: [`6e5fbff`](https://github.com/Azrkiel/xvant-agent/commit/6e5fbffb23c0765b2b3b8c4dd0d4d1dd41678c8a),
  canonical temp storage and one Windows worker, with unchanged behavioral checks.
- Work package 3: this evidence/index and final documentation commit, reviewed in
  [PR #10](https://github.com/Azrkiel/xvant-agent/pull/10).

[Runner guide](../../autonomy/a00-runner.md), [evidence index](../README.md),
[machine-readable observations](index.json), and [retained file checksums](SHA256SUMS).
Receipts identify the tested commit separately from the source content hash;
source inventories deliberately exclude `docs/evidence/`. Subsequent status and
runner-guide edits are documentation changes; the final PR checks exercise the
submitted head again. Follow the PR checks link for the current head, and the
pinned run links below for the durable historical observations.

## Acceptance results

| Criterion | Result     | Observed evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A00-C1    | **Passed** | Fresh clone and empty npm cache installed with `npm ci --ignore-scripts --no-audit --no-fund`; [baseline receipt](baseline-passed.json) and [bundle](baseline-passed.tar.gz): 31 checks / 1,428 tests / 113 suites passed. [Implementation local receipt](implementation-linux-local.json): 31 / 1,441 / 115 passed. Hosted Linux and Windows independently installed and passed the same integrated gate; their qualified receipts are linked below.                                                                                                                                                                                              |
| A00-C2    | **Partial** | [PR Linux job](https://github.com/Azrkiel/xvant-agent/actions/runs/43367284166/job/131694576532), [receipt](ci-linux-passed.json), [source admission](ci-linux-passed-source-validation.json), [bundle](ci-linux-passed.tar.gz). Actual checkout and receipt revision are `7bb00ada15cf912ed4cbcb2cd367ffa2328f0db7`, not the PR merge SHA. All 31 stages and every required suite are admitted. [Deleted-suite run](https://github.com/Azrkiel/xvant-agent/actions/runs/43367338919) failed even though Vitest itself exited 0 with 1,439 tests; [receipt](ci-missing-suite.json) reports `Missing or reduced suite: tests/release-sign.test.ts`. |
| A00-C3    | **Passed** | [Deliberate assertion run](https://github.com/Azrkiel/xvant-agent/actions/runs/43367338661) failed: one of 1,442 tests failed, gate exit 1, diagnostics uploaded. [Receipt](ci-failing-fixture.json), [bundle with assertion/stack trace](ci-failing-fixture.tar.gz). [Unavailable-browser run](https://github.com/Azrkiel/xvant-agent/actions/runs/43367338498) failed UI setup and standalone browser exit 2 with `status: unavailable`; [receipt](ci-missing-browser.json), [bundle](ci-missing-browser.tar.gz). All proof jobs were genuinely red, with no `continue-on-error` or retry.                                                       |
| A00-C4    | **Passed** | [Workflow](../../../.github/workflows/offline.yml) uses `contents: read`, `persist-credentials: false`, no secrets, no provider logins, no `pull_request_target`, and only the offline gate. [Observed token permissions](ci-runner-permissions.log): Contents/Metadata read. Package/browser installation uses public downloads; artifact upload uses GitHub's scoped artifact service, not a repository write credential.                                                                                                                                                                                                                        |
| A00-C5    | **Partial** | Linux receipts above are independent of Windows qualification. The [runner guide](../../autonomy/a00-runner.md) documents Tini `-s`, OpenSSH, SQLite, and the observed Chromium sandbox setup failure. Process-death/reaping assertions stayed intact. The corrected Windows and Linux jobs each passed 31 checks / 1,441 tests; their independent receipts are recorded below. Neither platform is an unattended/live qualification.                                                                                                                                                                                                              |
| A00-C6    | **Passed** | [Index](../README.md), [machine index](index.json), source manifests in each bundle, runtime/host details in receipts and setup logs, [job/artifact metadata](ci-jobs.json), durable archives and checksums. Git-tracked evidence survives 30-day Actions artifact expiry. Retained data was checked with the existing secret detector; no private keys, databases, profiles, credentials, or live transcripts are included.                                                                                                                                                                                                                       |

## Platform and controlled-failure scope

Linux baseline: Debian 13.6, recorded Linux kernel/host in
[host record](baseline-host.json), Node 24.21.0, npm 12.0.2, SQLite 3.53.4,
Chromium 156.0.8078.79, OpenSSH 10.0p2, Tini 0.19.0. Hosted Linux uses Ubuntu
24.04 and the locked Playwright browser; exact versions are in
[setup log](ci-linux-passed-setup.log) and the receipt. The initial Linux local/CI implementation content
hashes match: `2af9f61170a5b9db3f58078ac59385726e35d32deba5d98550e6626fd5434582`.

Windows: **passed** on Windows Server 2025 / `win32 10.0.26100`, independently
recorded in the [qualified job](https://github.com/Azrkiel/xvant-agent/actions/runs/43368644128/job/131699034676),
[receipt](ci-windows-qualified.json), [bundle](ci-windows-qualified.tar.gz),
[setup](ci-windows-qualified-setup.log), [path probe](ci-windows-qualified-runner-preflight.json),
and [journal probe](ci-windows-qualified-journal-preflight.log). All 31 checks and
1,441 tests in 115 suites passed. Node 24.21.0, npm 12.0.2, SQLite 3.53.4,
Git 2.56.0.windows.4, OpenSSH 10.6p1, Chromium 153.0.8010.12. The journal-limit test
took approximately 3.04 seconds under coverage, within the original 15-second
bound (initial failing setup: 31.68 seconds).

The corrected Linux and Windows jobs both tested `6e5fbffb23c0765b2b3b8c4dd0d4d1dd41678c8a`
and recorded the same source hash:
`5bc38301302e0d84593777fba1be50baa7073d35159d21eb7b629baf57ab4fa5`.
[Corrected Linux receipt](ci-linux-qualified.json), [bundle](ci-linux-qualified.tar.gz),
and [job](https://github.com/Azrkiel/xvant-agent/actions/runs/43368644128/job/131699034967).
Coverage passed on both platforms: Linux lines 95.55%, branches 89.43%; Windows
lines 95.58%, branches 89.70%. Detailed function/statement and per-file coverage
are in the bundled summaries. Final source changes after this revision are
runner documentation, status/evidence records and evidence byte-preservation
attributes; CI exercises the final submitted head again.

Controlled failures are separate disposable Linux-only branches based on
`7bb00ad`. They were never merged into the implementation branch. Reproduce the
exact mutations with the retained patches:
[assertion](proof-failing-fixture.patch), [browser](proof-missing-browser.patch),
[deleted suite](proof-missing-suite.patch). Their source hashes differ by design;
the failed-job receipts must never be presented as a pass of the submitted source.
The browser failure has no coverage summary because the UI hook failed; the
missing-suite run retains its passing test report and coverage but fails gate
admission. Complete bundle integrity means preserved bytes, not passing behavior.

## Design changes, interfaces, migration and rollback

The implementation keeps the original gate and all coverage/fault assertions.
It raises stale suite floors to the observed baseline and adds ten previously
unlisted existing suites. A regression test requires every checked-in test suite
in phase 10. New tests add thirteen test cases; no existing test was removed.
`ci-policy.ts` requires the complete 31-stage roster, source identity, required
suite counts and structured artifacts. When intentionally adding gate stages or
tests, update their required manifests in the same reviewed change.

The gate clears stale test/coverage/manifest output, captures the source manifest
before checks, and archives available test JSON/coverage even on failure. CI
checks a clean source checkout and verifies the exact receipt's immutable bundle.
Evidence and GitHub job metadata are observations, not autonomous product acceptance.

`XVANT_BROWSER` now registers an authoritative executable; a missing or empty
registration fails closed. Unset it to restore automatic system discovery.
Linux CI uses an ephemeral browser launcher with `--no-sandbox` for trusted local
fixtures, matching Playwright's Linux fixture setting. This is a documented host
setup decision, not browser/worker isolation qualification; allowed-origin,
blocked-request, screenshot and cleanup checks are unchanged. A sandbox-capable
host is the alternative for browser isolation work, which belongs to later scope.

The Windows runner correction is supported by the [initial failed receipt](ci-windows-initial-failed.json)
and [path probe](ci-windows-path-diagnostic.json): Node preserved `RUNNER~1`, while
Git expanded it to `runneradmin`, producing different root/scope identities.
CI configures a canonical `RUNNER_TEMP/xvant-fixtures` for `TEMP`/`TMP`/`TMPDIR`
and serializes Windows suites to reduce durable-I/O contention. It reruns the
original journal-limit test before the full gate. Neither `synchronous=FULL`,
the 4,096-frame limit, the 15-second journal deadline, nor the process-death
assertions changed. Changing product path comparison or persisted lesson scope
was avoided because the runner can satisfy their existing strict contract.

No product state, schema, database or API migration is required. Rollback by
reverting the milestone's implementation/docs commits, or keep the branch
unmerged. Existing evidence remains historical and must not be relabeled.
There is no mutable runtime state or dependency cache in CI to migrate or erase.

## Remaining limits and next useful task

- **Not run:** live provider/model calls, real account/subscription qualification,
  unattended Windows operation, hostile-worker/browser isolation, autonomous
  daemon/resume/integration behavior, and long-running release fault campaigns.
- Installation needs public network access. Offline fixture qualification is not
  an air-gapped installation claim. Hosted runner images and OS packages can
  change; receipts record the versions actually observed.
- The clean local baseline used a fresh checkout/cache on the recorded cloud host;
  it was not a newly provisioned VM. Hosted CI independently supplies fresh runners.
- The explicit browser launcher is limited to trusted fixtures. It does not grant
  a production sandbox or permission to run live workers.
- Actions downloads expire after 30 days; use the repository archives for durable
  evidence and promote future qualifying receipts before expiry. Archives preserve
  each run's declared artifacts; temporary databases and browser profiles are excluded.

Next useful task, after review/merge of A00 and a separately assigned request:
**A01 — Project and completion contracts**, starting with its first work package.
Do not infer permission to begin it from this handoff.

## Browser readiness follow-up

The [parallel Windows push job](https://github.com/Azrkiel/xvant-agent/actions/runs/43368639732/job/131699032575)
for `6e5fbff` passed all 1,441 tests but failed the standalone browser check.
[Receipt](ci-windows-browser-failed.json) and [bundle](ci-windows-browser-failed.tar.gz)
are retained. The original fixture suppressed the underlying error message, so
that run does not establish which browser startup boundary failed. It must not
be hidden by the passing PR run.

A deterministic delayed-page regression reproduces a startup defect in the
original implementation: DevToolsActivePort can exist before a page target is
registered, but the tool assumed a fixed 50 ms wait was sufficient. The
[red regression result](browser-readiness-before.log) records that failure.
The correction waits for readiness within the existing 15-second launch deadline,
without relaunching the browser or repeating navigation. It preserves terminal
protocol failures and timeout/cleanup checks. The fixture now records a bounded,
redacted underlying error message for future diagnosis. Three new regression
cases raise the required total to 1,444. Fresh full-gate qualification is pending.
