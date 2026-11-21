# A05 durable project backlog

This draft implements work package 1 from the
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
the effect journal and legacy manual acceptance. Take a pre-upgrade backup
with the service stopped. Roll back by restoring it to a separate state
directory for the older binary. Keep the upgraded store and original
worktrees available for reconciliation.

The backlog describes proposed work. Saving a plan creates no root, dispatch,
provider turn, resource reservation or acceptance decision. The next work
package needs the qualified A04 service. It can read `Store.contracts.getBacklog`
for current durable planning facts. Admission and dispatch must use A01
authority and the durable A04 queue. A03 must reconcile interrupted effects
before work is repeated. Work packages 2 and 3 still need the manager cycle,
durable task/evidence links, bounded repair and the unattended demonstration.
