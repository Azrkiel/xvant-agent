# A03 recovery and reconciliation

Recovery runs through the existing root resume command and authenticated local
app endpoint. Each decision records the root action slot, original attempt and
dispatch generation, probing owner and generation, source, evidence and
outcome. The original intent and its absolute deadline stay in the action
journal. SQLite commits the decision and any change to action or reservation
state together. Identical observations in one ownership generation have one
audit entry.

| Durable state or observation | Classification | Decision |
| --- | --- | --- |
| Crash before intent commits | No action exists | Continue from the checkpoint cursor |
| Intent committed and still prepared | Not started | Claim the original intent |
| Claim committed without its dispatch marker | Not started | Reset to prepared with the original attempt, then claim under a new dispatch ID |
| Dispatch marker committed and matching local process is alive | Owned and running | Hold reservations and wait for evidence |
| Dispatch marker committed without sufficient process or effect evidence | Unresolved | Hold reservations and show the missing evidence |
| A tracked process has exited without a terminal receipt | Stopped and incomplete | Preserve the workspace and hold reservations while descendants or remote effects remain unaccounted for |
| Terminal receipt or reconstructed Git result passes its evidence checks | Completed and verifiable | Commit the result and advance the original cursor |
| A verified terminal failure is available as a durable receipt | Stopped and incomplete | Consume the failure through the existing repair policy and limits |
| Acknowledged action, cursor still behind | Completed and verifiable | Consume its existing receipt once |

The Linux process probe binds a child PID to the kernel boot ID, PID namespace
and process start tick. A missing or reused PID cannot authorize signaling or
prove that descendants or provider effects stopped. The probe reads process
metadata only. Restart recovery preserves worktree contents and partial
artifacts. Unsupported or unreadable process identities stay blocked.

Git recovery requires a clean, registered worktree on the original repository
and branch. An apply receipt requires the expected parent, the recorded
dispatch marker in the commit message, and the same tree from applying the
saved patch in a disposable index. This can write objects into the Git object
database. The live worktree, index and refs are left untouched by the probe.
An unchanged head with a nonempty patch is insufficient evidence for replay.

Initialization evidence also requires the dispatch marker in Git's worktree
administration directory. An interruption after checkout creation and before
that marker is available leaves the action blocked. A marked apply commit must
be the branch head and have exactly one parent. A dirty worktree, a missing or
corrupt object, and a mismatched commit or tree all leave the action, refs, and
user files available for inspection.

The host result probe consumes a terminal turn or check receipt from the
original dispatch. It checks the stored result shape and reads the patch by
content hash before releasing the action. Provider journal status is context
for investigation. A provider report of completion alone cannot substitute
for the host's verification, the exact turn result, or A01 acceptance
evidence. The existing provider journal continues to govern its reservations
and its separately authorized acceptance and reconciliation.

## Remote capabilities and operator flow

The trusted runner may bind a versioned remote adapter and conflict scope.
The operation ID is generated with the durable action intent. The attempt ID and
original absolute deadline stay the same across reconciliation. A reliable
lookup returns a terminal receipt containing both IDs and a host-verified
outcome. An adapter offering replay must use the same conditional
get-or-create protocol at initial dispatch and on replay, including when
requests race. The reservation scope must cover resources that can conflict.
The adapter must substantiate these guarantees for the bound service.

A resume performs one bounded read and, when supported and within the original
deadline, can admit one conditional replay. Each call has a two-second maximum
and receives an abort signal. A timeout, missing receipt, unsupported
capability or wrong correlation leaves the effect unresolved unless independent
evidence establishes it. Each conditional replay admission is recorded before
the call. Repeated resume requests can probe again. They keep the same remote
key and do not grant the old controller permission to write a result.

A prepared action holds no effect reservation. An authorized dispatch holds
its worker, workspace or integration worktree and any declared service scope.
A verified terminal outcome releases the workflow reservation. A live process,
recycled PID, missing artifact or unresolved external effect keeps the
reservation. Git repair at an intermediate dirty state requires inspection
outside this automatic flow. Recovery never signals a PID from the journal.
Existing live Codex, Claude and OpenCode adapters supply local process evidence.
Remote lookup and idempotent replay are demonstrated with a loopback service.

Run `npm run xvant -- resume ID` with the original state directory and checkout,
or use **Resume run** in the local app. An unresolved action produces a CLI
error or HTTP 409 with the action slot, attempt, missing evidence and safe
operator action. The authenticated root details show the persisted decision.
Inspect the named workspace, provider journal or service receipt as directed,
preserve partial files, and resume when better evidence becomes available.

## Compatibility and rollback

SQLite schema 8 adds dispatch and recovery records and leaves existing
checkpoints and provider records intact. Schema 7 prepared and completed
actions remain usable. A schema 7 pending dispatch has no new evidence binding,
so it remains explicitly blocked. Legacy graphs without checkpoints continue
through the previous interruption path. Existing manual acceptance and A01
authority and evidence requirements remain in force.

Create a pre-upgrade state backup for rollback. Older binaries reject schema
8. Restore the pre-upgrade backup into a separate destination and retain the
upgraded store for its newer intent, observations and decisions. State backups
include staged patch references and verify their objects. Keep the original
repository and worktrees separately because the state snapshot excludes them.
Restoring an old database cannot undo an external effect or Git commit.

## Milestone handoff

| Milestone | Status | Handoff |
| --- | --- | --- |
| A00 | Complete on the roadmap branch | Hosted Linux and Windows passed on the A00 branch head. [PR #10](https://github.com/Azrkiel/xvant-agent/pull/10), [hosted run](https://github.com/Azrkiel/xvant-agent/actions/runs/44861028668) |
| A01 | Merged into main | Authority and evidence remain required. [PR #13](https://github.com/Azrkiel/xvant-agent/pull/13) |
| A02 | Merged into main | Linux offline gate evidence covers the tested A02 PR head. Hosted, Windows and live-provider qualification remain open for A02. [PR #14](https://github.com/Azrkiel/xvant-agent/pull/14) |
| A03 | Draft for review | Recovery and reconciliation evidence and validation receipts are listed in the draft PR. Hosted, Windows and live-provider qualification remain open for A03. |

The [autonomy roadmap](https://github.com/Azrkiel/xvant-agent/blob/codex/autonomous-agent-plan/docs/autonomy/README.md)
and hosted workflow live on `codex/autonomous-agent-plan`. The A03 change
targets `main`. Use the A03 handoff and its draft PR to update the roadmap
when the review and qualification status changes.

A04 should reuse `Orchestrator.checkpoint`, `Orchestrator.resume`,
`Store.workflows.actions`, `Store.workflows.dispatch`,
`Store.workflows.recoveries`, and the generation-fenced settlement path.
`RecoveryBlockedError` carries the blocking decisions for an operator queue.
A scheduler should wait for a reservation or new evidence rather than create
an independent attempt for the same effect. Workers and provider processes
can leave descendants or effects after their leader exits. Those cases still
require evidence from the original environment or service.

| Criterion | Fixture |
| --- | --- |
| A03-C1, A03-C2, A03-C3, A03-C6, A03-C7 | [Controller process, worktree and Git crash tests](../apps/controller/src/workflow-resume.test.ts) |
| A03-C4, A03-C5 | [Loopback service and lost-response tests](../tests/faults/workflow-remote.test.ts) |
| A03-C3, A03-C5 | [Same-generation fence and legacy migration](../packages/storage/src/workflows.test.ts), [local app blocked-state test](../apps/controller/src/app.test.ts) |
