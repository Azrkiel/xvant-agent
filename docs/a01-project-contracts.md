# A01 project and completion contracts

A01 introduces opt-in project, policy, and task contracts for the local host.
The existing root-run commands and UI retain their manual review and acceptance
workflow. The contract flow uses the same SQLite writer lease and command
journal. Its task and attempt IDs are separate from legacy run IDs.

See the [pinned A01 subplan](https://github.com/Azrkiel/xvant-agent/blob/0a036ae0be9394dc8f1a63915ca2f82eb7902c9b/docs/autonomy/01-project-contracts.md)
and the [offline fixture](../apps/controller/src/project-contracts.test.ts) for
working project, policy, scout, and ship examples.

## Authorize work

The project records the owner's objective, requirement IDs and descriptions,
exclusions, and repository scope. A policy version applies to one project
version and specifies permitted actions, providers, budget ceilings, required
checks, review rules, and escalation. A task pins both versions and a Git base
commit. It carries the owner's task objective and the manager's implementation
brief with separate actor IDs. The authenticated local app session and local CLI
are owner entry points. The manager brief and worker output are data.

Use the canonical absolute checkout path for the repository. Path prefixes
are literal and repository-relative. A prefix grants the named path and its
descendants, and `.` grants the root. Exclusions take precedence and match
case-insensitively. Children can narrow the parent repository path scope,
requirements, actions, providers, budgets, and delivery grants. They retain
the parent's base commit. Free-text exclusions record owner intent. Put
enforceable path exclusions in `scope.excludedPaths`.

A scout can read and produce a sourced report. The host checks that its
checkout is at the authorized base without tracked or unignored untracked
changes, and that each source is a blob at that revision within scope. It
stores the report and its content digest. A ship task derived from the report
requires a separate owner authorization with `sourceReport.taskId` and
`sourceReport.revision` identifying the accepted report. That link is
provenance. The new task's current policy and scope determine its authority.

A ship task can deliver a local candidate. The host checks the candidate
commit and its ancestry against the pinned base, and collects paths from all
introduced commits, including changes later reverted. PR creation and merge
are independent grants. Each requires its own explicit flag, current authority,
and an accepted candidate. A01 evaluates these flags through local fixtures.

## Evaluate completion

The host records an immutable observation per attempt. The expected evidence
subject includes the exact report digest or candidate commit, its base, task
and attempt identities, requirement IDs, project and policy versions, and
verifier ID and configuration digest. Required checks must pass and cover
every assigned requirement. Required review must approve that subject and come
from an eligible reviewer who did not produce the result.

| Observation on the current task                         | Human review ready | Automatic acceptance eligible |
| ------------------------------------------------------- | ------------------ | ----------------------------- |
| No result, failed or unknown outcome                    | No                 | No                            |
| Stale authorization, out-of-scope or invalid artifact   | No                 | No                            |
| Valid artifact, empty, missing, failed, or stale checks | Yes                | No                            |
| Valid artifact, changed verifier in the receipt         | Yes                | No                            |
| Valid artifact, missing, stale, ineligible, rejected, or unknown required review | Yes | No |
| Valid artifact, passing checks and required review, automatic acceptance disabled | Yes | No |
| Valid artifact, passing checks and required review, automatic acceptance enabled  | Yes | Yes |

`manual` acceptance requires matching evidence and an owner actor ID.
`exception` requires policy permission, an owner actor ID, a reason, and a
review-ready artifact. It records the blocked checks and review alongside the
exact accepted result. A scope violation, stale authorization, or unknown work
outcome prevents either mode. An exception leaves automatic eligibility as
evaluated by the evidence. Updates to project intent, scope, policy, or verifier
configuration must advance the appropriate version. The current version
invalidates outstanding tasks and their evidence, and revokes old delivery
authority. Historical observations and decisions remain in the journal.

## Entry points

Submit the same JSON command to authenticated `POST /api/v1/contracts` or to
`npm run xvant -- contracts apply --file command.json`. Command kinds are
`project`, `policy`, `task`, and `accept`. Project and policy commands wrap
their respective record and include `expectedVersion` (zero for creation) and a
stable `commandId`. A task command wraps `task` and has a stable `commandId`.

An acceptance command names the task, its observed row version, and the exact
result. For example, with the checked commit from `contracts task fix-order`:

```json
{
  "kind": "accept",
  "commandId": "accept-fix-order-1",
  "taskId": "fix-order",
  "acceptance": {
    "expectedVersion": 2,
    "attemptId": "fix-order-attempt-1",
    "revision": "0123456789abcdef0123456789abcdef01234567",
    "mode": { "kind": "automatic" }
  }
}
```

Inspect the current decision with `contracts task ID` or
`GET /api/v1/contracts/tasks/ID`. Inspect the latest project and policy records
with `contracts project ID` or `GET /api/v1/contracts/projects/ID`. A project
update requires a new policy for the new version. An acceptance response contains
the saved decision in `acceptance`, including `accepted: false` for a denial
on the named result. The CLI exits nonzero for that denial. A replay returns
the original command receipt. Query task status for current authority.

## Compatibility, rollback, and A02 interfaces

Schema migration 6 is additive. It creates project and policy revision tables
and task and attempt identity tables. Legacy task and graph rows keep their
previous meanings. Existing backups remain restorable and migrate on the next
writer open. Keep a pre-upgrade backup for rollback. The previous binary rejects
a version-6 database. Restore the pre-upgrade backup before reopening it with
that binary, and retain the upgraded store if its intervening records matter.
Git candidates are identified by commit and remain in their Git repository.

A02 can reuse the schemas in [contracts](../packages/contracts/src/project.ts),
`admitProjectTask`, `completionSubject`, and `decideCompletion` in
[policy](../packages/policy/src/project.ts), and the fenced writes and snapshots
in [ProjectContracts](../packages/storage/src/project-contracts.ts).
[Orchestrator.observeContractResult](../apps/controller/src/orchestrator.ts)
is the host-only adapter boundary for observed artifact and receipt facts.
Trusted verifier and review adapters supply their observed subjects. Owner
CLI and app requests can authorize and request acceptance through the shared
command handler. They have no receipt submission action.

Reuse stable command IDs and compare task row versions when committing
observations and acceptance. Observation attempts have unique IDs and count
against the task's attempt ceiling. An unknown attempt remains recorded
pending reconciliation. Reservations, cumulative resource accounting, durable
dispatch, and reconciliation remain later work.
