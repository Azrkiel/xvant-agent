# First A09 gate attempt

The source at `1975b1bd2a4230ef839dab83c7f905f763e19370` passed
typecheck, lint and 162 focused tests. The phase-10 gate reported
1,515 passing tests and one failure. The existing daemon takeover
fixture observed `database is locked` while waiting for the new owner.
The externally timed SIGSTOP could pause the old process between
recording the worker call and releasing its SQLite dispatch transaction.

The follow-up test schedules the real SIGSTOP from the fixture after
that transaction exits and observes the process stopped. The original
lease, deadlines, coverage floors, durability settings, and stale-result
assertions are retained.

[Gate receipt](gate-receipt.json) · [Immutable bundle](gate-bundle.tar.gz) · [Checksums](SHA256SUMS)
