# A08 durable GitHub intake

This draft implements signed issue receipt and deduplication on the A04
daemon. It targets the A05 backlog draft so the inbox migration follows
the manager schema 11. A05 manager admission, A07 promotion, and A04 physical-suspend
qualification are still open. See the [A08 subplan](https://github.com/Azrkiel/xvant-agent/blob/493ce4686b413e1e1a4ab5297b8169a33c9b9360/docs/autonomy/08-events-and-integrations.md).

## Configuration and receipts

The loopback daemon accepts GitHub issue notifications only when
`XVANT_GITHUB_WEBHOOK_CONFIG` points to a service-account-only JSON file.
The file contains an array of objects with `repositoryId` (the stable
numeric GitHub repository ID) and `secret` (a unique webhook secret of at
least 32 characters). Keep the file out of the repository and restrict
its permissions to the service account. When running a fixture, POST the
raw JSON to `/hooks/github/REPOSITORY_ID` with the GitHub delivery, event
and SHA-256 signature headers. The existing daemon listener stays bound
to loopback. A hosted trial also needs an approved inbound transport.

The handler authenticates raw payload bytes, checks the repository identity
against the route, limits requests to 128 KiB, and commits the receipt under
the SQLite writer fence before returning 202. It stores IDs, timestamps and
fingerprints. Issue text and secrets are omitted. Replaying a delivery ID
with different bytes returns 409. Deliveries with older source revisions
remain in the journal. Distinct observations at the newest timestamp that
disagree are held for a fresh read. GitHub's timestamp granularity is one
second.

Open, edit, close and reopen notifications are recorded as observations.
Use authenticated `GET /api/v1/daemon/github/REPOSITORY_ID/issues/NUMBER`
to see the newest observed issue revision and whether a fresh read is
needed. Treat the current revision as a coalescing hint. A future A05
consumer must load the current source and admit any derived task under the
current owner policy. A07 must provide the exact verified candidate and
publication authority before the A03 effect path may submit a remote write.

## Upgrade and rollback

Schema 12 adds `github_issue_deliveries` and its revision index. Verified
snapshots include and validate this table. Disable intake by removing the
configuration and restarting the daemon. Back up while stopped before
upgrading. Restore the pre-upgrade backup to a separate state directory
for an older reader and retain the upgraded store for its delivery
receipts.

Next implement bounded polling and schedule cursors against an approved
read-only integration. Test missed events, equal timestamps, cursor expiry
and rate limits before enabling the manager consumer. Run the hosted
issue-to-task and lost-PR-acknowledgment trial after A05 and A07 qualify and
an approved disposable repository is available.
