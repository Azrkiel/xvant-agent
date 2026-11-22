# A08 criterion handoff

The signed intake uses the A04 daemon writer lease and builds on the
A05 schema 11 manager draft. It adds inbox schema 12. A04 physical suspend
remains partial. The A05 offline manager supports owner-admitted runs, and
A07 evidence-bound publication remains unavailable. See the
[intake and migration guide](../../../a08-durable-inbox.md).

| Criterion | Status | Observation |
| --- | --- | --- |
| A08-C1 | Partial | The daemon stores one receipt per delivery ID. The fixture confirms the newer issue state wins over reordered input. Distinct same-second observations that disagree require a fresh read. Task admission from the current issue state remains open. [Focused output](focused.log) |
| A08-C2 | Not run | Polling and its durable cursor are pending. A missed webhook was not recovered in this draft. |
| A08-C3 | Partial | A real daemon restart preserved the receipt and deduplication. The fixture retries the same event after discarding the first reply. A verified snapshot also preserves the receipt and replay identity. Processing crashes and lost remote write replies remain open. [Focused output](focused.log) |
| A08-C4 | Not run | Agent-origin causality and CI write feedback require the remote integration. The intake fixture observed zero jobs and zero worker turns. [Focused output](focused.log) |
| A08-C5 | Passed offline | Invalid HMAC, an unconfigured repository, a signed payload with a mismatched repository ID, and oversized input were rejected. No invalid observation entered the inbox. [Focused output](focused.log) |
| A08-C6 | Not run | Recurring schedules, timezone changes and GitHub rate-limit recovery are pending. |
| A08-C7 | Blocked | Requires eligible issue-to-task admission, an A07-bound verified candidate, a qualified integration account, and an approved disposable GitHub repository. A03's correlated loopback fixture verifies its remote effect recovery alone. [A03 evidence](https://github.com/Azrkiel/xvant-agent/pull/15#acceptance-evidence) |

## Validation

Tested source `b7d8dc9e3a4541b1a8d8082ed4aff3bace75f632` on A05
base `e97d719fef88eeea19c49f8d67124105063d3de4`. Main was
`f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run lint
docker-init -s -- npm test -- tests/faults/daemon.test.ts \
  apps/controller/src/{app,project-contracts,workflow-checkpoint}.test.ts \
  apps/controller/src/http/server.test.ts \
  packages/storage/src/{artifacts,backup,providers,store,workflows}.test.ts
docker-init -s -- npm run gate -- --phase 10 --offline
```

The clean detached source used separate tmp and XDG paths and the A00
trusted-fixture Chromium launcher. Debian 13.7, Linux 6.18.57 x86_64,
Node 24.21.0, npm 12.0.2, SQLite 3.53.4, Git 2.56.1, Chromium
156.0.8078.79, OpenSSH 10.0p2 and Tini 0.19.0. Standalone typecheck
and lint passed. All 190 focused tests and all 31 gate stages passed.
The gate counted 1,515 tests in 120 suites, with 93.61% line and
87.44% branch coverage.

The [first focused attempt](../a08-first-focused/README.md) retains
the failure from a missing snapshot validator entry for schema 12.
Hosted, Windows, GitHub integration and live-provider qualification
were not run for this branch.

[Exact invocations](focused.command) · [Runner](runner.log) · [Integrated receipt](gate-receipt.json) · [Immutable bundle](gate-bundle.tar.gz) · [Checksums](SHA256SUMS)
