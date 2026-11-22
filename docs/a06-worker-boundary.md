# A06 offline Linux worker boundary

Work package 1 introduces an opt-in Bubblewrap launcher for offline
qualification. The [A06 subplan](https://github.com/Azrkiel/xvant-agent/blob/493ce4686b413e1e1a4ab5297b8169a33c9b9360/docs/autonomy/06-isolation-and-budgets.md)
requires live provider qualification and durable resource reservations in
later work packages.

## Operator inputs and mounts

The launcher requires Linux, a system-managed non-setuid
`/usr/bin/bwrap`, enabled unprivileged namespace creation and explicit
operator approval. A caller supplies a dedicated runtime image and staged
input under separate directories. The operator prepares and holds both paths
stable for launch and execution. They may contain only approved material,
including any nested mounts or file links. Start from a dedicated runtime
image and a fresh export of the permitted inputs. A repository worktree or a
host directory can carry extra mounts, Git metadata, sockets or hard links.
The launcher validates mount points and checks that the image and staging
directories are disjoint. The preparation of their contents is trusted.

| Sandbox path | Contents and access |
| --- | --- |
| `/` | Read-only dedicated runtime image, including its binaries and libraries |
| `/input` | Read-only staged inputs |
| `/workspace` | Private writable 32 MiB tmpfs and initial working directory |
| `/tmp` | Private writable 32 MiB tmpfs and home directory |
| `/proc` | Read-only view of the new PID namespace |
| `/dev` | Bubblewrap's synthetic devices |

The launcher uses private PID, user, IPC, network, UTS and cgroup namespaces,
drops capabilities, disables nested user namespaces and requests cleanup on
parent death. The host launcher gets a small explicit environment. The worker
gets fixed `PATH`, `HOME`, `TMPDIR` and `LANG` values. Relative filesystem
access starts in the scratch directory. No host workspace write mount,
provider credential, shared network or host agent socket is provisioned.

`WorkerSupervisor` owns the launcher handle and supplies timeouts,
cancellation and bounded stdout/stderr. Scratch files disappear when the
namespace exits. The only output is the bounded process result, which the
host treats as untrusted. A future artifact exporter must validate content and
associate it with the original authorized action before integration. A cgroup
namespace by itself does not allocate cgroup resource limits.

## Reproduce the Linux exercise

Use the [A00 runner guide](https://github.com/Azrkiel/xvant-agent/blob/493ce4686b413e1e1a4ab5297b8169a33c9b9360/docs/autonomy/a00-runner.md)
for Node, npm, OpenSSH, Chromium and subreaping. Install Bubblewrap 0.12.0 or
use an approved host with that version. Run from a clean checkout on the
disposable Linux runner.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run lint
docker-init -s -- npm test -- packages/supervisor/src/index.test.ts packages/supervisor/src/interactive.test.ts
docker-init -s -- node tests/fixtures/linux-offline-worker.mjs
docker-init -s -- npm run gate -- --phase 10 --offline
```

The [standalone fixture](../tests/fixtures/linux-offline-worker.mjs) builds a
small image with the pinned Node executable and its shared libraries. It
checks access to its own input and scratch data, denial of writes to the
image and input, denial of access to unrelated files and a host-path symlink,
absence of an inherited credential marker, and denial of connections to
disposable host TCP and Unix listeners. A second run checks deadline cleanup
of a detached descendant. This probe needs real namespace support and runs
separately from the portable gate. A missing launcher, incompatible host, or
failed sandbox setup prevents the proposed worker from executing.

## Handoff

The draft PR records the implementation and base SHAs, runner versions,
exact results, and status for A06-C1 through A06-C7. Migration is unnecessary.
The new launcher has no daemon or provider admission entry point. Roll back
by removing callers of the opt-in launcher and reverting the code change.
Existing trusted-local processes continue to use the supervisor's existing
launch path.

Work package 2 needs a supported provider/auth profile, an approved account,
a host with delegated resource limits, and validated artifact export. Extend
the boundary tests to cover the profile's network policy and whole-environment
CPU, memory, process and disk limits. Work package 3 needs a transactional
budget ledger with uncertainty carried through restart and child allocation.

## Resource reservation and report export

The offline launcher can require a dedicated delegated cgroup v2 directory.
The launcher enters a newly allocated child before Bubblewrap or its worker
starts. Set the CPU quota per 100 ms, memory limit with swap disabled,
process count and combined scratch capacity. The cgroup caps CPU, memory
and processes across descendants. The private workspace and temporary
directory each receive half the configured scratch capacity. Completion
requires a kernel observation of an empty cgroup after cleanup. Keep the
group for investigation if cleanup cannot establish that it is empty.

`runBudgetedLinuxReport` is a host-only entry point for an A01 scout. It
requires this delegated boundary and acquires a durable allocation before
launch, using the action ID as the original attempt identity. A previous
reservation refuses another dispatch. A complete successful launch can
export one bounded JSON text report through stdout. Export validates the
process identity, frame schema and size, rejects credential-shaped text, and
stores the bytes by SHA-256 in the existing object store. The receipt binds
the hash to the action, worker, input and profile. Staging and report truth
remain the responsibility of the host caller and independent verification.

Schema 10 adds global limits and dispatch reservations. The ledger checks
current A01 versions, the project and every task ancestor in one fenced
SQLite transaction. Each allocation consumes one cumulative attempt. Usage
that is absent or unknown is charged at the full reservation until trusted
settlement. Measured overruns are charged in full. The offline report path
uses no live credentials or paid tokens, so the ledger provides no guarantee
about live financial caps. Capture a verified pre-upgrade backup and retain
the new store, object directory and cgroup evidence for reconciliation. To
roll back, restore the backup to a separate directory for the older binary.

The current runner exercises Bubblewrap and offline export. Whole-environment
CPU, memory, process and disk qualification still requires delegated cgroups
on an approved Linux runner. Codex, Claude and OpenCode profiles all refuse
launch in this draft. The missing live dependencies are a qualified profile,
approved test credentials and an approved network path. This draft leaves
A06 and dependent A07 incomplete.
