# XVANT

Original local agent harness. Phase 2 adds durable SQLite state, supervised simulated workers, process checks, an authenticated loopback API, and verified snapshots. The default demos make no model calls; the explicitly approved OpenCode live probe below does.

## Run

Install Node **24.21.0** and npm **12.0.2**, then run from this directory:

```sh
npm ci --ignore-scripts
npm run demo
npm run demo -- quota
npm run demo:durable
npm run gate -- --phase 02 --offline
```

On this Windows workstation, an isolated Node binary is available. Use it for the current PowerShell session:

```powershell
$env:PATH = "$PWD/.tools/node_modules/node-win-x64/bin;$PWD/.tools/node_modules/.bin;$env:PATH"
node --version
npm run gate -- --phase 02 --offline
```

The local `.tools` directory is ignored and is not required on another machine. Use the pinned Node version there. If a managed Windows trust store is needed for package installation, set `NODE_USE_SYSTEM_CA=1`; certificate verification stays enabled.

## What Phase 1 does

- Validates task, attempt, worker, event, and evidence contracts with Zod.
- Keeps work revisions separate from state versions. Missing, failed, duplicated, or stale check receipts cannot approve work.
- Rejects duplicate worker IDs, aliases, and native session identities.
- Validates dependency DAGs independently of parent hierarchies: up to 20 nodes and three hierarchy levels. Lower limits are supported.
- Runs success, failure, delayed, malformed, quota, and unknown simulation scenarios.
- Reserves one turn per worker. A stream must obey task/attempt identity, event order, size limits, and one terminal outcome.
- Runs host-registered verification callbacks. Worker output cannot supply trusted receipts. Success reaches `ready_for_acceptance`; an explicit controller `accept` call is still required.
- Generates `docs/evidence/G01.json`, logs, a source manifest, suite counts, and coverage. Missing/skipped/failed tests fail the gate.

```mermaid
flowchart LR
 A[Validated task] --> B[Queued]
 B --> C[Simulated worker]
 C --> D{Valid terminal output?}
 D -->|No| E[Needs attention]
 D -->|Yes| F[Trusted fixture checks]
 F -->|Pass| G[Ready for acceptance]
 F -->|Fail| H[Needs rework]
 G -->|Explicit acceptance| I[Accepted]
```

## Phase 2 and boundaries

`npm run demo:durable` executes a simulated worker in a child process, runs a host-registered process check, reopens the database, accepts persisted evidence, and verifies a backup/restore. Its temporary fixture is removed afterward. No listener or worker remains running.

Programmatic service entry: `startService(localStateDirectory, trustedChecks)` in `apps/controller/src/service.ts`. It returns the loopback origin, one-use bootstrap token, and a close method. The host delivers that token privately; never put it in a URL or log it. There is no UI yet.

Simulation hashes do not prove real code changes. Workspace IDs reserve logical resources; they do not isolate filesystem access. Restricted profiles fail closed: Windows taskkill/Linux process groups are not hostile-code containment. Unknown operations retain reservations until trusted reconciliation. Mixed live providers, subscriptions, Linux runtime qualification, and real repository attestation remain unverified.

Use local nonsynchronized storage. Snapshots restore into new directories only and preserve the controller lease TTL. Verify snapshots before recovering user data.

## Phase 3 offline foundation

`npm run probe -- --offline --runtime all` exercises ten synthetic provider
identities. `npm run probe -- --inventory-only --runtime all` reads CLI versions
without model calls. `npm run gate -- --phase 03 --offline` verifies the offline
foundation and all earlier suites. Those controllers reject live dispatch; this does not
complete the live Phase 3 milestone. See [adapter boundaries](packages/adapters/README.md).

## Layout

| Path                              | Responsibility                                      |
| --------------------------------- | --------------------------------------------------- |
| `packages/contracts`              | Validated boundary schemas and typed errors         |
| `packages/core`                   | Pure transitions, evidence consistency, graph rules |
| `packages/adapters/src/simulated` | Deterministic simulation and fault fixtures         |
| `apps/controller`                 | In-memory orchestration and runnable demo           |
| `scripts`                         | Offline gate and test-report validation             |
| `tests`                           | Gate-policy tests                                   |
| `docs/evidence`                   | Compatibility decisions and gate results            |

Run `npm test`, `npm run typecheck`, `npm run lint`, or `npm run format:check` for individual checks. Run the gate on each host to qualify that host.

## Durable OpenCode live integration

`LiveOpenCodeController` supports explicitly approved, trusted-local text turns with OpenCode **2.0.19** and **opencode/big-pickle**. It journals native session creation before spawning the CLI, atomically reserves the returned session ID, journals inference, validates the JSON stream, runs host-registered checks against stable workspace snapshots, and prepares evidence for explicit acceptance. Accepted sessions can resume within the same project, workspace, host, and account. Recovery retains uncertain reservations and never replays a prompt automatically.

Run the opt-in qualification with the installed executable:

```powershell
npm run probe:live:opencode -- --approve-live --executable "C:\Users\jiang\AppData\Local\hermes\node\node_modules\@opencode\cli\bin\opencode.exe"
```

This runs two real model turns, checks token recall on the same native session, reopens SQLite before each explicit fixture acceptance, and writes `docs/evidence/G03-opencode-live.json`. State and workspace artifacts remain under `.artifacts/opencode-live-*`. No paid fallback is configured. This provider-specific receipt does not complete the mixed-provider live G03 milestone.

The CLI inherits standard OpenCode configuration and permissions; it is not sandboxed. No automatic permission approval is supplied. Tool events and unknown output fail the text protocol, but rejecting an event cannot undo a tool already run. Use only trusted local workspaces. A controller permits one active run at a time. Interrupts, timeouts, and uncertain shutdown retain reservations for trusted reconciliation. The HTTP and offline fixture controllers remain separate and cannot qualify live evidence.
