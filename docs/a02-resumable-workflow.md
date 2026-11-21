# A02 resumable root workflow

XVANT saves new root runs as versioned executable checkpoints. An operator can
resume the same root, including planning, dependency-ordered node execution,
combined checks and fixes, and review and its repair. A resumed root still
stops for manual acceptance. The A01 project-contract authority and acceptance
path are separate and continue to apply to contract tasks.

## Resume a run

Use `npm run xvant -- resume ID` with the same `XVANT_HOME` and checkout, or
send an authenticated `POST /api/v1/roots/ID/resume` to the running local app.
A successful resume advances the existing root. A terminal root returns its
saved result. A checkpoint from a different orchestration version, an
incompatible runtime binding, or incomplete executable state produces an
explicit error. The previous graph and its artifacts remain available.

A checkpoint pins the resolved Git base, plan and planner feedback, check
commands and verifier digest, worker aliases and routing, runtime
fingerprints and model references, attempt counters, worktree and integration
identities, and repair budgets. Per-dispatch turn and check deadlines are
absolute. Provider credentials are resolved in the runtime environment at
dispatch. Set secrets through that environment and keep them out of objectives
and check commands. The checkpoint rejects recognizable credential formats in
its executable inputs and redacts recognizable formats in saved output.

## Dispatch and restart

| Last committed action status | Behavior on resume |
| --- | --- |
| No intent | The saved cursor can prepare a new intent. |
| Prepared | A new owner can claim the same intent with its original assignment, worktree, attempt ID, and deadline. |
| Dispatching | The effect may have occurred. Resume stops with the action slot for reconciliation. |
| Completed | Resume consumes the saved receipt and references. It skips the dispatch. |

Action preparation, task version, and checkpoint advance share a transaction
under the controller generation fence. A stale generation cannot acknowledge
an action. Repeated identical receipts are idempotent and a conflicting receipt
leaves the first result intact. Node progress and lesson updates commit
together. Patch bytes live in the existing content-addressed artifact store.
A receipt completed immediately before a crash can be consumed by the next
process even when the corresponding graph phase still needs to advance.

The integration worktree must match the persisted path, branch, Git repository,
and acknowledged head. An acknowledged apply can be one transition ahead of
the graph. The controller reuses that recorded commit and advances the graph.
A changed or dirty checkout remains available for inspection. A Git operation
that reached dispatch without a receipt requires reconciliation even when an
operator can see its apparent effects.

## Data compatibility and rollback

SQLite schema 7 adds the checkpoint and action tables. Prior graph, provider,
and A01 records retain their meanings. Legacy active graphs still use the prior
interruption flow because they have no executable checkpoint. Legacy ready
results remain manually acceptable.

The previous binary rejects schema 7. Keep a pre-upgrade backup for rollback,
restore it with the prior binary, and retain the upgraded store to preserve
newer decisions. Backups preserve the journal and object references. Root
resume also needs the original Git repository and worktrees, which the
standard state backup excludes.

## A03 handoff

The existing controller supplies `Orchestrator.checkpoint` and
`Orchestrator.resume`. A03 can inspect `Store.workflows.actions(rootId)`, which
returns action slots, ownership generations, prepared input, dispatch status,
and committed observations. Use those records to reconcile an effect that
stopped in `dispatching`. Keep the original intent and evidence when recording
the reconciliation decision. A02 resumes only where the journal establishes a
legal next step.

The process fixture covers real process termination around SQLite intent and
receipt commits, real Git worktrees and patches, fixture workers, the host
check subprocess, and final manual-review readiness. It does not establish
the outcome of a lost response from a live provider. [Crash fixtures](../apps/controller/src/workflow-resume.test.ts)
