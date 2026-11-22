# Phase A offline validation

The results here are fixture evidence for the specified commits. The
[roadmap handoff](../../autonomy/qualification-handoff.md) records
criterion states and remaining deployment evidence.

## Runner and isolation

Debian 13.7 x86_64, Linux 6.18.57, Node 24.21.0, npm 12.0.2, SQLite
3.53.4, Git 2.56.1, Chromium 156.0.8078.79, OpenSSH 10.0p2, and Tini
0.19.0 via `docker-init -s`. The A06 namespace fixture used Bubblewrap
0.12.0. Each gate used a fresh detached worktree, installed dependencies
without lifecycle scripts, used separate temporary and XDG paths,
and registered the [trusted-fixture Chromium launcher](../../autonomy/a00-runner.md#chromium-in-restricted-containers).

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run lint
# Run the milestone's focused command below before starting the gate.
docker-init -s -- npm run gate -- --phase 10 --offline
```

### A04

```sh
docker-init -s -- npm test -- apps/controller/src/daemon-clock.test.ts \
  tests/faults/daemon.test.ts tests/runtime-diagnostics.test.ts
```

On `560c487f7d049dc3dab16b2170fdc4d9ce1c4969` against A03 base
`845048ab6831e25b2b44b4747bb648ba83afd3e8`, typecheck, lint, 24 focused
tests and 31 gate stages passed. The gate counted 1,507 tests in 120
suites, with 94.23% line and 88.03% branch coverage.
[Focused output](a04/focused.log) · [Gate receipt](a04/gate-receipt.json) ·
[Immutable bundle](a04/gate-bundle.tar.gz) · [Checksums](a04/SHA256SUMS)

The rerun matched the original A04 source inventory. The merge record subsequently reported a physical reboot pass and an interrupted physical suspend. Both raw host receipts remain unavailable. Hosted CI, Windows and live-provider qualification remain open. [A04 PR and original simulation evidence](https://github.com/Azrkiel/xvant-agent/pull/16)

A separate offline rehearsal ran the host procedure's queue, SQLite
capture and endpoint-auth steps, replacing systemd operations and host
transitions with direct daemon process launches and SIGTERM. The replayed
acknowledgment, pinned Git base and original deadline were unchanged, the
new owner generation increased by one, and the stale token returned 401.
One unresolved planning action held its reservation, the two-slot root
made zero calls, and the eligible root dispatched one planning turn.
The installed unit was also parsed by systemd 257.13 with the local
executable paths substituted into a disposable copy.

```sh
XDG_RUNTIME_DIR=/workspace/work/a04-runner/unit/runtime \
  systemd-analyze --user --man=no --generators=no verify \
  /workspace/work/a04-runner/unit/xvant-daemon.service
```

### A05

```sh
docker-init -s -- npm test -- \
  apps/controller/src/{project-contracts,workflow-checkpoint,native-verifier}.test.ts \
  packages/storage/src/{artifacts,backup,lessons,memory,providers,store,workflows}.test.ts \
  tests/faults/daemon.test.ts
```

On `46a8bb55082ccc569e21619fbf5ed365967189ea` against A04 base
`560c487f7d049dc3dab16b2170fdc4d9ce1c4969`, typecheck, lint, all 221
focused tests and all 31 gate stages passed. The gate counted 1,512 tests
in 120 suites, with 94.27% line and 88.12% branch coverage.
[A05 criterion record](https://github.com/Azrkiel/xvant-agent/pull/18)

[Focused output](a05/focused.log) · [Gate receipt](a05/gate-receipt.json) ·
[Immutable bundle](a05/gate-bundle.tar.gz) · [Checksums](a05/SHA256SUMS)

#### Initial A05 gate failure

The initial A05 source `30c4d100b94dffb5e9bcc5164db5bc6e294ef832`
passed 66 focused tests. Its full gate found 26 failures because the
verified snapshot validator still capped supported schemas at 9 and
historical-schema fixtures left the schema 10 backlog table in place.
The runtime stage then failed when the durable demo requested a snapshot.
The correction adds validation for schema 10 and both backlog foreign
keys, updates the historical schema fixtures, and checks a schema 9
upgrade, backlog snapshot round trip and damaged schema 10 restore.
[Failed receipt](a05-first-gate/gate-receipt.json) ·
[Immutable bundle](a05-first-gate/gate-bundle.tar.gz) · [Checksums](a05-first-gate/SHA256SUMS)

### A06

```sh
docker-init -s -- npm test -- packages/supervisor/src/index.test.ts \
  packages/supervisor/src/interactive.test.ts
docker-init -s -- node tests/fixtures/linux-offline-worker.mjs
```

On `b98d042ca9fee8bd6c5744f97f29e2d1cfdddbe5` against main
`879167d8a2960f5b756d9f2b923585c2cf32e74a`, typecheck, lint, all 20
focused tests, the standalone namespace fixture and all 31 gate stages
passed. The gate counted 1,481 tests in 117 suites, with 95.02% line and
89.15% branch coverage. No host listener received a probe connection.
The fixture observed a detached child running before the deadline and
confirmed it had stopped afterward. [A06 criterion record](https://github.com/Azrkiel/xvant-agent/pull/17)

[Focused output](a06/focused.log) · [Namespace observations](a06/namespace.json) ·
[Gate receipt](a06/gate-receipt.json) · [Immutable bundle](a06/gate-bundle.tar.gz) ·
[Checksums](a06/SHA256SUMS)

### A06 report and budget follow-up

Tested `563223d230e97aca8fdda93a40dd44dfdafc4643` directly against
`main` at `f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`. The runner
and common setup above apply. The delegated cgroup v2 mount was
unavailable for writing on this runner.

```sh
docker-init -s -- npm test -- \
  apps/controller/src/{project-contracts,workflow-checkpoint}.test.ts \
  packages/storage/src/{artifacts,backup,store,integration,memory,providers,workflows}.test.ts \
  packages/supervisor/src/{index,interactive}.test.ts
docker-init -s -- node tests/fixtures/linux-offline-worker.mjs
```

Typecheck, lint, 195 focused tests, and the real namespace fixture passed.
The gate passed all 31 stages and 1,509 tests across 120 suites, with
92.91% line and 86.83% branch coverage. The fixture accepted a bounded
report with the original attempt and rejected a path field, truncation
and another generation. It denied the two host listeners and cleaned up
the detached worker. The ledger test retained a full unknown reservation
after restart and refused a duplicate dispatch. No provider session,
delegated-cgroup limit campaign, Windows or hosted run was performed.

[Setup](a06-limits-budget/setup.log) · [Focused output](a06-limits-budget/focused.log)
· [Namespace observations](a06-limits-budget/namespace.json)
· [Gate receipt](a06-limits-budget/gate-receipt.json)
· [Verified bundle](a06-limits-budget/gate-bundle.tar.gz)
· [Checksums](a06-limits-budget/SHA256SUMS)

### A05 manager follow-up

Tested `e97d719fef88eeea19c49f8d67124105063d3de4` directly against
`main` at `f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`. The common
runner and isolated setup above apply.

```sh
docker-init -s -- npm test -- \
  apps/controller/src/{project-contracts,workflow-checkpoint,workflow-resume,daemon-clock,native-verifier}.test.ts \
  packages/storage/src/{artifacts,backup,store,workflows}.test.ts \
  apps/controller/src/orchestrator.test.ts apps/controller/src/routing-default.test.ts \
  tests/faults/{daemon,workflow-remote}.test.ts
```

Typecheck, lint and all 219 focused tests across 13 suites passed. The
first focused run at `df2ebecf1508b3346c2150c930eeab2b84e038ca`
exposed a schema 11 snapshot validation gap. The new store version was
absent from the snapshot schema allowlist, and the rollback fixture expected
the previous current version. The corrected revision retained all snapshot
checks. [First focused run](a05-manager/focused-before-snapshot-fix.log)

The manager fixture used three dependent milestones and one parallel
opportunity. It retained the backlog, task budget and queue acknowledgment
through a real controller restart. It rejected a path excluded by A01,
exhausted a check budget, recorded an owner-authorized replan, replaced a
killed worker, repaired a failing check, and recorded independent review.
After acceptance, the three-second idle sample observed 30 ms CPU,
133,268 KiB RSS, no additional scheduler pass, and zero extra worker calls.
The target moved before exact-candidate manual acceptance and stayed at
the moved head. Separately, the A03 loopback fixture retained the unresolved
effect reservation across controller replacement with one submission.
No autonomous promotion, hosted, Windows or live-provider qualification
was performed.

The isolated gate passed all 31 stages and 1,513 tests across 120 suites,
with 94.03% line and 87.93% branch coverage.

[Setup](a05-manager/setup.log) · [Focused output](a05-manager/focused.log)
· [Gate receipt](a05-manager/gate-receipt.json)
· [Verified bundle](a05-manager/gate-bundle.tar.gz)
· [Checksums](a05-manager/SHA256SUMS)
