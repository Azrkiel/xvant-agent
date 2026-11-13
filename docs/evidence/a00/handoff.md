# A00 handoff

Status: in progress. Work package 1 complete; CI and final evidence qualification
are pending. Prerequisites: none. Plan branch baseline:
`71b7b4e7559eaa9607a45aabcdb841faaccf404b`.

The [clean baseline receipt](baseline-passed.json) records 31 passing checks,
1,428 passing tests in 113 suites, and passing coverage thresholds. Its
[immutable bundle](baseline-passed.tar.gz) preserves the test JSON, coverage
summary, source manifest, and check logs. The fresh clone's source content hash
was `bea04add7fae3710af50ad8f36b9783d949d3f05cf6178e4ff36555de406a4bb`.
Read the receipt's actual hash if comparing programmatically.

The [first failed receipt](baseline-browser-failed.json) and
[bundle](baseline-browser-failed.tar.gz) retain the Chromium launch failure.
The [launch diagnostic](baseline-browser-launch.log), [corrected browser
result](baseline-browser-fixed.log), [install log](baseline-install.log),
[gate log](baseline-gate.log), and [host details](baseline-host.json) document
what was needed. The [runner guide](../../autonomy/a00-runner.md) is reproducible
without developer-local assets. This is Linux fixture qualification on the
recorded cloud host, not a fresh VM image or live-provider qualification.

| Criterion | Observed result |
| --- | --- |
| A00-C1 | Passed: clean checkout/install and full baseline gate above. |
| A00-C2 | Not run: workflow implementation follows work package 1. |
| A00-C3 | Partial: local failed browser gate retained; failed CI jobs pending. |
| A00-C4 | Partial: offline baseline used no live calls; CI permission inspection pending. |
| A00-C5 | Partial: Linux runner setup and reaping pass documented; Windows not run. |
| A00-C6 | Partial: durable baseline evidence indexed; CI retention and final handoff pending. |

No database/schema or product interface changes. Rollback: revert this milestone's
commits or leave the implementation branch unmerged; evidence remains historical.
Next useful task within A00: work package 2. A01 has not begun.
