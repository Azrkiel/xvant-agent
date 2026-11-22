# A05 durable project backlog

This draft implements the durable backlog and an offline manager cycle from the
[A05 subplan](https://github.com/Azrkiel/xvant-agent/blob/493ce4686b413e1e1a4ab5297b8169a33c9b9360/docs/autonomy/05-project-manager.md).
An owner can persist a series of immutable backlog revisions and read the
latest record or any prior revision. The new records are available through
the authenticated local API and CLI.

## Record and inspect a plan

First create an A01 project and a policy for its current version. Follow
the [A01 contract guide](a01-project-contracts.md) for those commands.

```json
{
  "kind": "backlog",
  "commandId": "plan-fixture-1",
  "expectedRevision": 0,
  "backlog": {
    "schemaVersion": 1,
    "projectId": "fixture",
    "projectVersion": 1,
    "policyVersion": 1,
    "revision": 1,
    "reason": "Prepare the owner-approved fixture",
    "milestones": [
      {
        "id": "inspect",
        "title": "Inspect the existing fixture",
        "reason": "Observe the failure before making changes",
        "priority": 1,
        "dependsOn": [],
        "requirementIds": ["reproduce"]
      }
    ],
    "notes": []
  }
}
```

```sh
npm run xvant -- contracts apply --file backlog.json
npm run xvant -- contracts backlog fixture
npm run xvant -- contracts backlog fixture 1
```

Use the same JSON with authenticated `POST /api/v1/contracts`. Read
`GET /api/v1/contracts/projects/fixture/backlog` or append the positive
revision number for history. While the A04 daemon is running, the new
backlog CLI commands use its authenticated endpoint. With no daemon
endpoint, they open the local state directly.

Each milestone names current project requirement IDs and may depend on
other milestones in the same revision. The host checks IDs, dependencies,
and requirement membership. Notes can record decisions, questions and
blockers. Questions and blockers name a next action. A note can refer
to one of the revision's milestones.

An edit uses a new command key, the preceding `expectedRevision` and
the consecutive new revision. An identical retry returns the original
receipt. A changed payload under that key or an out-of-date expected
revision conflicts. Project or policy updates mark the current backlog
stale until a new revision binds to the current project and policy.
Historical plans are returned as superseded. The snapshot includes the
current owner objective, requirements and policy budget ceilings.

## Handoff and compatibility

Schema 10 adds the `contract_backlogs` table. It preserves roots, queued work,
the effect journal and legacy manual acceptance. Verified snapshots check
both composite references from backlog revisions to their project and policy
records. Take a pre-upgrade backup
with the service stopped. Roll back by restoring it to a separate state
directory for the older binary. Keep the upgraded store and original
worktrees available for reconciliation.

Saving the backlog alone creates no root, dispatch, provider turn, resource
reservation or acceptance decision.

## Offline manager cycle

A host with an injected offline runner and a registered verifier can use
authenticated `POST /api/v1/contracts/projects/ID/manager`. Submit the
current backlog revision, an unused A01 ship-task ID, a stable command ID,
and the milestone IDs and permitted write paths. Each milestone can name an
explicit worker or tier. `maxActive` defaults to one and `maxRepairs` to one.
The verifier must match the check IDs, requirement coverage and exact
configuration digest in the current policy.

The daemon builds one deterministic root graph for the revision. Milestones
keep their requirement IDs in the backlog and their dependency and routing
facts in the root. The A04 queue and A03 effect journal own its execution.
Disjoint steps may run together when the assigned workers and slots permit.
The host reserves the run's worst-case worker turns and check time against
its task grant and the cumulative project grant. A restart reuses the
checkpoint, queue entry and reservations. An owner can record a revised
backlog after failed work or terminal cancellation. The old run remains
inspectable and its allocation still counts. A queued, running, or
unreconciled run prevents changes to its active authorization.

Read the same manager URL with GET to inspect historical runs, routing
through their root IDs and the current A01 evidence decision. The fixture
can register a local candidate for ordinary A01 acceptance. Accepted
exceptions remain separately visible. With accepted check and review
evidence, the project becomes idle. Candidate promotion and unattended live
workers depend on A06 and A07. This implementation plans one root per
owner-approved revision. Model-generated replans and a separate scout route
through the manager remain open.

Schema 11 adds the manager-to-backlog, task, and root links. Take a verified
pre-upgrade backup. To roll back, restore it to a separate state directory
for the older binary and retain the upgraded data and worktrees.
