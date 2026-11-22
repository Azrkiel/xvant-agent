# A09 criterion handoff

The A01 task contract and A05 persisted backlog set the boundaries for
project decisions. The offline A05 manager injects eligible decisions
into milestone prompts before the durable turn intent commits. The
structured decision fields reuse the existing SQLite memory schema.
See the [knowledge and comparison guide](../../../a09-project-knowledge.md).

| Criterion | Status | Observation |
| --- | --- | --- |
| A09-C1 | Partial | Project, requirement and revision bindings exclude foreign, stale and forgotten memory from the host packet. A real manager fixture recorded a current decision in early node prompts and omitted it after the integration head changed. The manager hook excludes anchored decisions because it supplies no file hashes. A structured external-runtime search is pending. [Focused output](focused.log) |
| A09-C2 | Passed offline | Reopening SQLite recovered the rationale, actor and decision. In a real restarted A05 daemon the queued manager turn obtained the eligible decision through its durable project/task binding. [Focused output](focused.log) |
| A09-C3 | Passed offline | Worker proposals use a restricted schema and cannot assign authority bindings or acceptance. The A09 API binds versions and owner identity on the host. Existing project authority and worker proposal tests passed. [Focused output](focused.log) |
| A09-C4 | Passed offline | The selector excluded changed or missing anchors and invalidated decisions when requirements or authority versions changed. The manager fixture omitted decisions once the code no longer matched the pinned base. [Focused output](focused.log) |
| A09-C5 | Passed offline | A sealed export retained source actor, revision, rationale and requirement references. Import preserved the original project, actor and bundle hash, created proposals and kept them out of task packets. [Focused output](focused.log) |
| A09-C6 | Passed offline | A synthetic retained corpus of 1,000 decisions was tested against the 300 ms and 32 KiB bounds. One integrated run returned 16 items, 31,713 bytes, in 5.30 ms. [Immutable bundle](gate-bundle.tar.gz) |
| A09-C7 | Partial | The separate-store process fixture pinned the same Git source and objective for both settings. Lesson mode survives checkpointing. The handoff specifies blinded paired allocation and measures. Repeated live outcomes await A11. [Comparison guide](../../../a09-project-knowledge.md) |

## Validation

Tested source `7ee1955ab1a315388f244bc758e2f3f84bd098be` on A05
base `e97d719fef88eeea19c49f8d67124105063d3de4`. Main was
`f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`. A05's offline manager
fixture supplied enough prerequisite behavior for project decision
selection. Its live qualification remains open.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run lint
docker-init -s -- npm test -- \
  apps/controller/src/{project-contracts,orchestrator,turn-runner,native-turn-runner}.test.ts \
  packages/storage/src/{memory,lessons}.test.ts packages/context/src/transfer.test.ts \
  packages/memory/src/relevance.test.ts tests/faults/daemon.test.ts
docker-init -s -- npm run gate -- --phase 10 --offline
```

The clean detached source used separate tmp and XDG paths and the A00
trusted-fixture Chromium launcher. Debian 13.7, Linux 6.18.57 x86_64,
Node 24.21.0, npm 12.0.2, SQLite 3.53.4, Git 2.56.1, Chromium
156.0.8078.79, OpenSSH 10.0p2 and Tini 0.19.0. Standalone typecheck
and lint passed. All 162 focused tests and 31 gate stages passed.
The gate recorded 1,516 tests in 120 suites, 94.06% line and
87.99% branch coverage. Hosted, Windows and live-provider qualification
were not run for this source.

The [first integrated receipt](../a09-first-gate/README.md) retains
the database-lock failure in the externally timed takeover fixture.
The corrected fixture suspends the daemon after its dispatch transaction.
Its stale-owner and timing assertions remain in force.

[Exact invocations](focused.command) · [Runner](runner.log) · [Integrated receipt](gate-receipt.json) · [Immutable bundle](gate-bundle.tar.gz) · [Checksums](SHA256SUMS)
