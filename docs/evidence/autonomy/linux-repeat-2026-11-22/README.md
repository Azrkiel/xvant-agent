# A05 and A06 Linux repeat qualification

This run tested both implementation drafts independently against `main` at
`f20da7e4dbd4f4a776ca60ace39c72f3dd2c7593`. The requested heads and bases
matched at intake and at the end of testing. [Verified refs](refs.json)

| Draft | Tested head | Focused tests | Phase-10 offline gate |
| --- | --- | --- | --- |
| A05 [#18](https://github.com/Azrkiel/xvant-agent/pull/18) | `e97d719fef88eeea19c49f8d67124105063d3de4` | 219 passed in 13 files | 31 stages and 1,513 tests passed |
| A06 [#17](https://github.com/Azrkiel/xvant-agent/pull/17) | `563223d230e97aca8fdda93a40dd44dfdafc4643` | 195 passed in 11 files | 31 stages and 1,509 tests passed |

Each gate ran 120 test files with zero failures or pending tests.
A05 coverage was 94.05% lines and 87.95% branches. A06 coverage was
92.91% lines and 86.83% branches. Clean installation, typecheck and lint
passed for both drafts. The gates ran sequentially in fresh detached Linux
worktrees, with separate temp, home and XDG directories.

## Runner and commands

Ubuntu 26.04.1 LTS on WSL2 x86-64, Linux
`6.18.33.2-microsoft-standard-WSL2`, Node 24.21.0, npm 12.0.2, Git 2.53.0,
SQLite 3.53.4, Chrome for Testing 153.0.8010.12 from locked Playwright 1.63.0,
OpenSSH 10.2p1 and Tini 0.19.0. Each gate used the
[A00 trusted-fixture Chromium setup](../../../autonomy/a00-runner.md#chromium-in-restricted-containers).
A05 recorded the system Bubblewrap 0.11.1. A06 used a checksum-verified Debian
Bubblewrap 0.12.0 binary at `/usr/bin/bwrap` in a private mount namespace.
The A06 tests ran as the unprivileged runner user.
[A05 runner](a05/runner.txt) · [A06 runner](a06/runner.txt) ·
[Debian package checksum](https://packages.debian.org/trixie/amd64/bubblewrap/download)

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run lint

# A05
tini -s -- npm test -- \
  apps/controller/src/{project-contracts,workflow-checkpoint,workflow-resume,daemon-clock,native-verifier,orchestrator,routing-default}.test.ts \
  packages/storage/src/{artifacts,backup,store,workflows}.test.ts \
  tests/faults/{daemon,workflow-remote}.test.ts

# A06
tini -s -- npm test -- \
  apps/controller/src/{project-contracts,workflow-checkpoint}.test.ts \
  packages/storage/src/{artifacts,backup,store,integration,memory,providers,workflows}.test.ts \
  packages/supervisor/src/{index,interactive}.test.ts
tini -s -- node tests/fixtures/linux-offline-worker.mjs

# Each full gate
tini -s -- npm run gate -- --phase 10 --offline
```

[A05 exact command log](a05/commands.log) · [A06 exact command log](a06/commands.log)

## A05 manager and unresolved effect

The fixture exercised three dependent milestones and a parallel step, a
failed check and one bounded repair, worker death, and a controller restart
after queue acknowledgment. The target moved after verification. Manual
acceptance remained bound to the verified candidate, preserved the moved
target and reached idle. The three-second idle sample recorded 10 ms CPU,
135,368 KiB RSS, zero extra scheduler passes and zero worker calls. The
separate opaque loopback effect kept its original reservation across
controller replacement with one submission.
[Manager assertions](https://github.com/Azrkiel/xvant-agent/blob/e97d719fef88eeea19c49f8d67124105063d3de4/tests/faults/daemon.test.ts#L647) ·
[Unresolved-effect assertions](https://github.com/Azrkiel/xvant-agent/blob/e97d719fef88eeea19c49f8d67124105063d3de4/tests/faults/workflow-remote.test.ts#L185)

- C2, C5 and C6 passed offline.
- C1, C3, C4 and C7 are partial. Pending scope includes promotion,
  model-originated replans, live resource accounting and live account blocking.

[A05 focused log](a05/focused.log) · [Gate summary](a05/gate-summary.json) ·
[Gate log](a05/gate.log) · [Original receipt and bundle digests](a05/original-artifact-digests.txt)

## A06 namespace and durable budget

The first namespace attempt hit an `ESRCH` race reading
`/proc/<pid>/cmdline`. The unchanged command passed after the portable gate,
with the original deadline, process cleanup assertions and SQLite durability
settings. It observed denied unrelated paths and host listeners, a clean
environment, bounded report export and cleanup of a detached process.
The focused ledger test retained the full unknown reservation across restart
and rejected over-allocation and duplicate dispatch.

- C1 and C3 through C7 are partial.
- C2 and the whole-environment cgroup campaign are blocked. The run had no
  approved delegated cgroup v2 scope or approved live provider profiles
  and accounts. There were no live provider calls.

[Initial namespace error](a06/namespace.log) · [Retry](a06/namespace-retry.log) ·
[Namespace receipt](a06/namespace.json) · [Focused log](a06/focused.log) ·
[Gate summary](a06/gate-summary.json) · [Gate log](a06/gate.log) ·
[Original receipt and bundle digests](a06/original-artifact-digests.txt)

## Evidence integrity

The full receipts and compressed bundles were preserved on the qualification
workstation. Each archive was extracted and verified with the repository's
bundle verifier. Its receipt matched the separately saved original byte for
byte. The copies here omit host-specific paths and console styling from the logs. The
per-draft checksums cover the LF-formatted evidence in this commit.
[A05 bundle verification](a05/bundle-verified.txt) ·
[A06 bundle verification](a06/bundle-verified.txt) ·
[A05 checksums](a05/SHA256SUMS) · [A06 checksums](a06/SHA256SUMS)

## Next qualification

Use an approved delegated cgroup v2 runner for A06 whole-environment limits
and restart recovery. Use individually approved provider profiles and
accounts for live qualification. Before combining A05 and A06, assign
distinct SQLite migration versions, validate upgrade and snapshot paths
from the common released base and rerun the combined gate. A07 promotion
depends on the qualified A06 boundary for trusted verification and review.
