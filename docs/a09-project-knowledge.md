# A09 project knowledge and lessons comparison

This draft builds on the persisted owner backlog in A05 draft #18 and A01
task contracts. The manager cycle and its task-packet dispatch integration
remain open. See the [A09 subplan](https://github.com/Azrkiel/xvant-agent/blob/493ce4686b413e1e1a4ab5297b8169a33c9b9360/docs/autonomy/09-memory-and-learning.md).

## Record and inspect decisions

Create a project, current policy, and backlog using the [A05 guide](a05-project-backlog.md).
Use the authenticated local API at
`/api/v1/contracts/projects/PROJECT/knowledge`. GET reads the backlog and
up to 32 decision records and history entries. POST accepts commands such
as this proposal.

```json
{
  "action": "propose",
  "commandId": "record-decision-one",
  "id": "reset-fixture-state",
  "expectedBacklog": 1,
  "revision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "content": "Reset fixture state before each assertion.",
  "details": {
    "rationale": "The test order must stay independent.",
    "alternatives": ["Run each assertion in a separate process."],
    "requirementIds": ["order"]
  }
}
```

Accept, reject or forget with a new `commandId`, decision `id`, and its
`expectedVersion`. An exact retry returns the original acknowledgment.
A new decision can supersede an accepted record by naming its ID in
`supersedes`. Ownership, current versions and the decision's audit fields
come from the host. Knowledge cannot change contract authority.

The host can call `ProjectKnowledge.forTask` using the admitted task ID and
trusted hashes from its pinned checkout. It uses the task's project,
project/policy version, current backlog revision, base and requirements.
Changed or missing file anchors exclude the record. Any new project,
policy or backlog revision conservatively requires rebinding. The search
selects up to 32 candidates and returns up to 32 KiB of serialized optional
context. The reference exercise uses 1,000 retained decisions and a
300 ms local retrieval bound. Legacy worker memory search cannot read
these structured decisions through its legacy route.

GET with `?export=true` seals up to 32 current accepted decisions per
project. Import with `action` set to `import`, a `commandId`, and the
exported `bundle`. The import retains source actor, project, revision and
bundle hash and creates proposals. To adopt one, review the source and
record a new owner proposal against local requirements and revision.
Credential-shaped decision content is withheld. Schema 10 and existing
manual runs are unchanged. Older readers ignore the new local decision
fields, and older bundle readers require bundles without the optional
extended decision and provenance fields.

## Prepare the lessons comparison

Freeze a task manifest before assigning work. Record exact Git revisions,
objectives, trusted checks, runtime/model builds, quotas, timeouts,
parallelism, repair bounds and review settings. Pair each task across two
independent repository copies and two fresh state roots. Keep the
assignment fixed. Use the normal submit path in the enabled arm and add
`--no-lessons` in the disabled arm. Each arm uses its own daemon. The
switch is persisted in the checkpoint and reused on resume.

Start both stores empty for the unseeded trial. If using seeded training,
freeze its inputs and store hash in advance. Keep the scorecard blinded
to the arm where possible. Collect actual acceptances, verification
failures, repair rounds, hinted and unhinted outcomes, wall time, usage,
and operator interventions for every run. Preserve failures and include
all preassigned tasks. The checked-in fixture verifies independent
stores, equivalent Git input and durable mode settings. The A11 campaign
still needs task execution through the manager, pinned live profiles, and
repeated paired runs.
