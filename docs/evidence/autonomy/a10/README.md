# A10 criterion handoff

Tested source `c46008c25a04e42a59352924fb7269172292b7b6` on main
`f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`. This draft builds on A04.
A04's physical-suspend criterion, A06 supported live execution, and A07
promotion remain open. The main-based draft covers the independently
testable operations surface. See the [operator runbook](../../../a10-operator-operations.md).

| Criterion | Status | Observation |
| --- | --- | --- |
| A10-C1 | Partial | Chromium and the CLI showed the saved queue state, pinned base, checkpoint step, progress age, reservation and turns or repair counters. The view retains check/review and reconciliation evidence. A06 budgets and A07 project-level proof are pending. [Focused evidence](focused.log) |
| A10-C2 | Passed offline | Real API and CLI commands returned the original receipt on replay and rejected new commands made against stale run and daemon versions. The queued cancel caused zero worker calls. Chromium applied drain and cancel through the guarded routes. [Focused evidence](focused.log) |
| A10-C3 | Partial | CLI backup, verification and restore into a fresh local directory preserved the dispatch journal, original attempt and one held worker reservation. The restored daemon remained blocked and made no repeat call. Removing a referenced artifact prevented backup and restore. Fresh supported host coverage is pending. [Focused evidence](focused.log) |
| A10-C4 | Partial | SIGKILL at a synthetic migration's precommit boundary rolled back the new table, kept integrity and kept the unresolved dispatch. Existing upgrade/rollback tests passed. The actual installed-service upgrade and authority drill is pending. [Focused evidence](focused.log) |
| A10-C5 | Partial | Backup and snapshot fixtures preserve referenced objects and retained unreferenced evidence. The installed-service retention and disk-pressure cleanup drill remains open. [Focused evidence](focused.log) |
| A10-C6 | Blocked | Requires bounded alerts, operator diagnostics and supported-profile credential-redaction evidence. |
| A10-C7 | Blocked | The systemd user manager is offline on this runner. The unit passed static verification with local Node and Tini paths. The installed-service walkthrough requires a supported host and a second operator. [Unit verification](systemd-verify.log) |

## Qualification commands and evidence

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run lint
docker-init -s -- npm test -- tests/faults/daemon.test.ts tests/e2e/ui.test.ts \
  packages/storage/src/{backup,artifacts,store}.test.ts \
  apps/controller/src/{app,daemon-clock}.test.ts
docker-init -s -- npm run gate -- --phase 10 --offline
```

The clean detached source used separate temp and XDG paths and A00's
trusted-fixture Chromium launcher. Debian 13.7, Linux 6.18.57 x86_64,
Node 24.21.0, npm 12.0.2, SQLite 3.53.4, Git 2.56.1, Chromium
156.0.8078.79, OpenSSH 10.0p2, Tini 0.19.0 and systemd 257.13.
Standalone typecheck and lint passed. All 80 focused tests and 31
gate stages passed. The gate reported 1,511 tests in 120 suites,
94.48% line and 88.43% branch coverage.

During development a new fixture initially expected HTTP 200 from a
POST. The checked-in fixture asserts the existing HTTP 202 response
and the final source passed. Hosted CI, Windows and live-provider checks
were not run for this source. The systemd check is static fixture evidence.

[Exact invocations](focused.command) · [Runner](runner.log) · [Integrated receipt](gate-receipt.json) · [Immutable bundle](gate-bundle.tar.gz) · [Checksums](SHA256SUMS)
