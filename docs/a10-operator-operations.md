# A10 daemon operations

This draft works with the [A04 Linux service](a04-daemon.md) and the
existing manual run surface. Its [A10 subplan](https://github.com/Azrkiel/xvant-agent/blob/493ce4686b413e1e1a4ab5297b8169a33c9b9360/docs/autonomy/10-operations.md)
also requires the completed A06 isolation and budget ledger and A07
verification and promotion. Project-level proof, budgets, alerts and
the installed-service drill are still pending.

## Inspect and control

Use `npm run xvant -- daemon status` for the queue and worker reservations.
Add a run ID to inspect saved checkpoints, pinned base, progress age,
verification, review and recovery details. In the UI, select the run for
the same queue state and progress. Use **Daemon controls** to pause intake,
pause dispatch, drain, or continue. A blocked recovery names the missing
evidence and suggested check. Preserve its worktree, original deadline,
artifacts and reservations. Resume asks the existing A03 reconciler to
probe the outcome again.

A CLI request can use `--observed-version HASH` with the version from
daemon status or from a run's `operations.observedVersion`. For example:

```sh
npm run xvant -- daemon pause-intake --id pause-maintenance --observed-version "$DAEMON_VERSION"
npm run xvant -- daemon drain --id drain-maintenance --observed-version "$CURRENT_DAEMON_VERSION"
npm run xvant -- daemon resume "$RUN" --id resume-after-evidence --observed-version "$ROOT_VERSION"
```

Use the same command key and payload to retry a lost reply. A new request
with an obsolete observation returns `CONFLICT`. Refresh status before
choosing a new action. Existing CLI callers can still send their original
unversioned commands. The browser uses observed versions and retries a
transport failure once with the original key.

## Backup, upgrade and restore

Use the pinned tooling in the [A00 runner guide](https://github.com/Azrkiel/xvant-agent/blob/493ce4686b413e1e1a4ab5297b8169a33c9b9360/docs/autonomy/a00-runner.md).
Use persistent local storage and the dedicated Linux service account.
Drain and wait for the daemon to show `drained: true`, then stop the
installed unit. Record the queue, decisions, uncertain dispatches and
their reservations. The backup excludes Git worktrees and repository
objects. Preserve the original repositories and registered worktrees.
Keep the endpoint manifest and credentials out of operator evidence.

```sh
systemctl --user stop xvant-daemon.service
npm run xvant -- backup --out "$BACKUP_DIR"
npm run xvant -- backup verify --from "$BACKUP_DIR"
XVANT_HOME="$RESTORE_STATE" npm run xvant -- restore --from "$BACKUP_DIR"
```

Use a fresh destination to exercise restoration. The backup manifest
must include every object referenced by SQLite, including patch hashes
recorded in unsettled dispatches. The verifier checks SHA-256 and sizes.
Restore verifies the staged database before swapping it into place.
Backup snapshots may include unreferenced retained objects. Preserve those
objects along with referenced objects until ownership and retention rules
are qualified. Keep the verified pre-upgrade backup and an independently
verified recovery copy before retiring older backup directories.

With the unit stopped, point the service at the pinned new source and
run the documented install procedure. Start the unit and verify its
generation, task and authority versions, and pending recovery before
continuing dispatch. If startup is interrupted, keep the state and
journal. Inspect the schema version and integrity before retrying.
An older binary may reject a newer schema. Restore the pre-upgrade
backup into a fresh state directory for rollback and keep the upgraded
state for reconciliation.

The offline process fixture kills a migration before commit and verifies
that it rolls back. It then backs up and restores a stopped daemon into a
fresh state directory, compares its unresolved dispatch journal, and
observes a blocked recovery with the reservation intact. A separate
fixture removes a referenced object and verifies that both backup and
restore reject the omission.

## Independent operator walkthrough

The installed-unit walkthrough still needs a supported Linux host and a
second operator. Record its unit and host details and have the operator
use this runbook to install, pause, drain, inspect a blocked action,
back up, verify and restore, and retry an interrupted upgrade. Capture
where the runbook leaves steps unclear. Keep fixture observations separate
from installed-service and independent-operator evidence.
