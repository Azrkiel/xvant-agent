# A04 daemon and scheduler

A04 is in draft review. The single-host Linux daemon owns root execution and
the durable schedule. The handoff is stacked on
[A03 PR #15](https://github.com/Azrkiel/xvant-agent/pull/15) at
`845048ab6831e25b2b44b4747bb648ba83afd3e8`. Retarget to `main` and revalidate
against current main after A03 merges. The status belongs to the A04 row of
the [separate autonomy roadmap](https://github.com/Azrkiel/xvant-agent/blob/codex/autonomous-agent-plan/docs/autonomy/README.md).
Host reboot, hosted and Windows qualification, and live-provider evidence
remain open.

## Run in a disposable Linux environment

Install Node 24.21.0, npm 12.0.2, Git and Tini. Run
`npm ci --ignore-scripts --no-audit --no-fund` from this checkout. Choose a
fresh state directory and repository with at least one commit.

```sh
export XVANT_HOME=/absolute/path/to/disposable-state
export XVANT_DAEMON_CONFIG="$PWD/tests/fixtures/daemon-runner.ts"
export XVANT_DAEMON_FIXTURE_DIR=/absolute/path/to/writable-fixture-directory
npm run xvant -- daemon start
npm run xvant -- daemon submit --id fixture-001 --repo /absolute/path/to/repo \
  --objective 'Exercise the offline daemon' --only codex --max-active 1 --no-review
npm run xvant -- daemon status
npm run xvant -- daemon stop --id stop-001
```

`daemon start` starts a detached subreaper and waits for the authenticated
ready response. Set `XVANT_DAEMON_INIT` to the installed Tini executable if it
is outside PATH or is named `docker-init`. Systemd runs `daemon serve` in its
foreground service. It sends TERM to the service supervisor and can remove
remaining children in the service cgroup after its stop deadline. For
process-death fixtures, use an outer subreaper for descendants orphaned by
the test itself.

For service-manager operation, install
[`xvant-daemon.service`](../deploy/systemd/xvant-daemon.service) under
`~/.config/systemd/user/`. The example expects the checkout at
`~/.local/share/xvant/source`, the pinned Node executable in
`~/.local/share/xvant/node/bin/node` and Tini at `/usr/bin/tini`. Adjust those
paths to the actual installation. Record any state path and trusted fixture
config in `~/.config/xvant/daemon.env`. The config module exports a default
object implementing the `AppOptions.discover` and `AppOptions.runner`
interfaces. The daemon starts with an empty runtime roster without this
configuration. Use offline adapters in A04. The state directory and config
module must be controlled by the service account.

Create the user unit directory with `mkdir -p ~/.config/systemd/user` if needed.
Run `systemctl --user daemon-reload` and
`systemctl --user enable --now xvant-daemon.service` to install and start.
A user service starts with the user manager. The host administrator controls
whether that manager runs without a login (systemd lingering). To uninstall,
run `systemctl --user disable --now xvant-daemon.service`, remove the unit
and optional environment file, and reload the user manager. Keep the
state and worktrees for recovery.

## Clients and controls

`XVANT_HOME` defaults to `~/.xvant`. It holds `state.sqlite`, `objects/`,
`runs/`, and a private `daemon/` directory with a rotating
`endpoint.json` and a CLI-start log. The endpoint file contains the
loopback address and a same-user operator credential. The service requires
a valid Host and Origin. CLI requests authenticate with the bearer
credential. `xvant ui` requests a short-lived, one-use browser login link
and exits. Browser sessions use the existing cookie and CSRF checks.

Use a unique `--id KEY` for each command. A repeated key and identical
payload return the original acknowledgment, even after takeover. A
different payload with the same key returns a conflict. A shutdown receipt names
the original owner generation. A submission
acknowledgment includes the root ID and an acceptance timestamp. At that
point SQLite has committed the command, exact base revision, checkpoint and
queue entry together. Use `--priority` and `--due-at` on submit, and
`--retry-at` on explicit resume. Times are absolute UTC instants with
offsets accepted by the CLI. When a daemon endpoint exists,
`xvant run`, `resume`, and `accept` also use the daemon. With the daemon
stopped, the standalone root flow remains available.

| Command | Intake | Dispatch and running work |
| --- | --- | --- |
| `pause-intake` | Reject new submissions and new adoptions. Duplicate acknowledgments and retries of accepted commands remain available. | Due accepted work can still be claimed when dispatch is open. |
| `pause-dispatch` | Leave intake as configured. | Keep queued jobs. Let current claims finish. |
| `drain` | Pause intake. | Pause new claims and let current claims finish. Status reports drained when running claims settle. Queued and unresolved work stay durable. |
| `continue` | Open intake. | Open dispatch and wake the scheduler. |
| `cancel RUN` | Persist a cancellation request. | Cancel queued work without an effect. Interrupt owned workers and checks in a running claim. Ambiguous work retains its reservation and cancellation request until reconciled. |
| `stop` | Close the local listener at shutdown. | Stop claiming, give active roots up to four seconds to settle and interrupt their owned children at the grace boundary. Preserve any unfinished checkpoint and effect reservation for takeover. Linux service-manager shutdown has a ten-second stop bound. |
| `resume RUN` | Adopt a compatible existing run or retry an already accepted blocked run. | Use the original checkpoint, limits, action IDs and evidence. An optional retry instant delays eligibility. |
| `accept RUN` | Require `--expected-version` and `--head` from the reviewed root. | Record manual acceptance through the existing version and head check. |

The local API exposes `GET /api/v1/daemon` for readiness, owner, generation,
intake and dispatch state, queue lag, progress age, scheduler passes, slot
use and reconciliation blocks. `POST /api/v1/daemon/control` accepts
`commandId` and `action`. Authenticated `/api/v1/roots` submits work and
root detail reports the job and A03 evidence. Root resume, cancel and
accept requests take a `commandId`.

## Recovery and limits

At startup, SQLite grants one ownership generation. The lease uses Linux
boot identity and elapsed boot time. Takeover resets old scheduler claims
and probes interrupted A03 actions before the daemon advertises readiness.
Startup probes can consume verified receipts or reset unarmed dispatches.
A correlated conditional replay still needs authorized dispatch. The
daemon preserves ambiguity and any A03 evidence and effect reservations.
Unresolved worker actions also hold global worker capacity. Use an explicit
resume after new evidence becomes available. A02/A03 legacy roots can be
adopted when their original worktrees and runtime bindings are available.
Checkpointless legacy roots retain their existing interruption path.

Jobs reserve their original `maxActive` slots and their bound worker aliases,
quota groups and declared remote scope for the claim. A03 still fences each
effect at dispatch and settlement. The scheduler serializes jobs for a
project, preferring the least recently served eligible project and then
higher priority within that project. Use disjoint fixture runtime selections
to run independent cohorts concurrently. A shared roster can conservatively
serialize jobs even when only some of its workers are busy. The global
limit is `XVANT_DAEMON_WORKERS`, default 3. Capacity held by unresolved
effects may require operator evidence before additional work can run.

The daemon wakes on command, settlement, readiness or the next stored due
or retry time. Its one-second lease heartbeat also notices when a forward
jump reaches a pending timer or running deadline. Scheduling uses an
absolute high-water clock anchored to Linux boot time, including suspend.
It persists the clock with fenced writes. Backward correction cannot extend
an original workflow deadline. After reboot the daemon retains the saved
absolute floor and uses the new boot clock.

## Compatibility, backup and rollback

Schema 9 adds queue, scheduling control, and boot-relative lease state to
the existing SQLite store. It preserves schema 8 workflow checkpoints and
A03 reservations. Take a verified pre-upgrade backup with
`npm run xvant -- backup --out DIR` while the service is stopped. Preserve
the separate repository and worktrees. State snapshots include SQLite and
artifact objects. For rollback, stop the service and restore a pre-upgrade
backup to a separate state directory for the earlier binary. Retain the
schema 9 state and worktrees for evidence. Check for Git or remote effects
before resuming from older state.

## Evidence and A05

The Linux fixtures use real CLI, daemon and worker processes. They exercise
a process kill after durable acknowledgment, lease takeover, a late
obsolete result, durable project ordering, lifecycle controls, and idle
and reconciliation-blocked operation. The clock fixture simulates backward
and forward corrections, suspend and boot identity changes. A host reboot
and a service-managed boot stay unqualified. The PR records the tested
commit, toolchain, commands, and individual criterion results.

| Criteria | Evidence |
| --- | --- |
| A04-C1, A04-C2 | [Acknowledgment, process kill and reconnect](../tests/faults/daemon.test.ts) |
| A04-C3 | [Competing processes and late result](../tests/faults/daemon.test.ts), [generation fence](../apps/controller/src/daemon-clock.test.ts) |
| A04-C4 | [Busy and due projects](../tests/faults/daemon.test.ts), [durable ordering and bounds](../apps/controller/src/daemon-clock.test.ts) |
| A04-C5 | [Controls and signal shutdown](../tests/faults/daemon.test.ts) |
| A04-C6 | [Deterministic clock and lease](../apps/controller/src/daemon-clock.test.ts), [A03 ambiguity fixtures](../apps/controller/src/workflow-resume.test.ts) |
| A04-C7 | [Idle and blocked resource samples](../tests/faults/daemon.test.ts) |

A05 can use the authenticated durable submit and status interfaces, or the
in-process `Store.daemonCommand`, `Store.schedule`, `Orchestrator.admit`,
`Orchestrator.checkpoint`, and `Orchestrator.reconcile` interfaces. Keep the
A01 authority checks and A03 effect journal as the host boundary for any
future manager policy.
