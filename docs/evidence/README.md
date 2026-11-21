# Verification evidence

A00 records fixture qualification only. The [runner guide](../autonomy/a00-runner.md)
explains the setup. The [A00 handoff](a00/handoff.md) maps acceptance criteria to
observations and records limits. Linux and Windows need independent receipts.

## Durable records

The `a00/` directory contains reviewed receipts, setup diagnostics, and compressed
copies of immutable evidence bundles. Each archive contains `bundle.json`, its
exact `receipt.json`, and the artifacts declared by that receipt. Failed receipts
are retained alongside passing ones. `a00/SHA256SUMS` covers every retained A00 file except the checksum manifest itself.
Git attributes preserve exact evidence bytes, including raw terminal progress output.

Git-tracked evidence persists with repository history and is the durable record.
GitHub Actions artifacts are convenient full downloads, retained for 30 days;
run/job URLs remain useful provenance after downloadable artifacts expire, but
are not a substitute for the checked-in bytes. Promote a reviewed receipt and
bundle before artifact expiry when qualifying a milestone. Never overwrite an
archived bundle or reinterpret a failed run as a pass.

## Verify retained bytes

From the repository root on Linux:

```sh
sha256sum -c docs/evidence/a00/SHA256SUMS
mkdir -p .artifacts/retained
for archive in docs/evidence/a00/*.tar.gz; do
  tar -xzf "$archive" -C .artifacts/retained
done
node --input-type=module -e 'import {readdirSync} from "node:fs"; import {verifyBundle} from "./scripts/evidence-bundle.ts"; for (const name of readdirSync(".artifacts/retained")) { const {bundle,problems}=verifyBundle(".artifacts/retained/"+name); console.log(name,bundle.receipt.status,bundle.integrity,problems); if(problems.length || bundle.integrity!=="complete") process.exitCode=1; }'
```

Integrity says whether recorded bytes were preserved, not whether verification
passed. Check each receipt's status, source revision, source manifest, commands,
platform, runtime, and limits. `dirtyTreeHash` inventories all indexed and
nonignored files except `docs/evidence/`; Git revision and content hash have
different purposes. CI validates both against the actual checked-out source.

Only allowlisted fixture logs, test JSON, coverage summaries, source manifests,
and receipts belong in ordinary CI artifacts. Do not upload `.env`, credential
files, homes, SQLite databases, browser profiles, signing keys, live transcripts,
or the complete runner environment. Live qualification has separate authorization
and disclosure requirements.

## A00 observations

All gate commands below use `npm run gate -- --phase 10 --offline`, with the
[documented setup](../autonomy/a00-runner.md). The receipt contains every command,
its exit status, the source revision/content hash, runtime, host, and limits.

| Observation                   | Platform                   | Result                                                         | Receipt / durable bundle                                                                                                                                                                                           | CI                                                                                                        |
| ----------------------------- | -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Clean baseline                | Linux / Debian 13.6        | **Passed**, 31 checks, 1,428 tests                             | [Receipt](a00/baseline-passed.json), [bundle](a00/baseline-passed.tar.gz), [host](a00/baseline-host.json)                                                                                                          | Fresh local clone and empty npm cache                                                                     |
| Initial browser setup         | Linux / Debian 13.6        | **Failed**, unusable sandbox helper                            | [Receipt](a00/baseline-browser-failed.json), [bundle](a00/baseline-browser-failed.tar.gz), [launch diagnostic](a00/baseline-browser-launch.log)                                                                    | Local; superseded by documented fixture launcher                                                          |
| Implementation                | Linux / Debian 13.6        | **Passed**, 31 checks, 1,441 tests                             | [Receipt](a00/implementation-linux-local.json), [bundle](a00/implementation-linux-local.tar.gz), [source admission](a00/implementation-source-validation.json)                                                     | Local implementation commit `7bb00ad`                                                                     |
| Initial CI implementation     | Linux / Ubuntu 24.04       | **Passed**, 31 checks, 1,441 tests                             | [Receipt](a00/ci-linux-passed.json), [bundle](a00/ci-linux-passed.tar.gz), [setup](a00/ci-linux-passed-setup.log)                                                                                                  | [PR job](https://github.com/Azrkiel/xvant-agent/actions/runs/43367284166/job/131694576532)                |
| Initial Windows setup         | Windows 2025               | **Failed**, 87 tests; path aliases and journal deadline        | [Receipt](a00/ci-windows-initial-failed.json), [bundle](a00/ci-windows-initial-failed.tar.gz), [setup](a00/ci-windows-initial-failed-setup.log)                                                                    | [PR job](https://github.com/Azrkiel/xvant-agent/actions/runs/43367284166/job/131694576307)                |
| Windows path probe            | Windows 2025               | **Failed preflight**, full gate **not run**                    | [Path spellings and scopes](a00/ci-windows-path-diagnostic.json), [log](a00/ci-windows-path-diagnostic.log)                                                                                                        | [Diagnostic job](https://github.com/Azrkiel/xvant-agent/actions/runs/43368401826/job/131698165447)        |
| Deliberate assertion          | Linux / Ubuntu 24.04       | **Failed as required**, 1 failed of 1,442 tests                | [Receipt](a00/ci-failing-fixture.json), [bundle/stack trace](a00/ci-failing-fixture.tar.gz), [patch](a00/proof-failing-fixture.patch)                                                                              | [Failed run](https://github.com/Azrkiel/xvant-agent/actions/runs/43367338661)                             |
| Unavailable browser           | Linux / Ubuntu 24.04       | **Failed as required**, UI hook and browser exit 2             | [Receipt](a00/ci-missing-browser.json), [bundle](a00/ci-missing-browser.tar.gz), [patch](a00/proof-missing-browser.patch)                                                                                          | [Failed run](https://github.com/Azrkiel/xvant-agent/actions/runs/43367338498)                             |
| Deleted signing suite         | Linux / Ubuntu 24.04       | **Failed as required**, discovery rejected 1,439 passing tests | [Receipt](a00/ci-missing-suite.json), [bundle](a00/ci-missing-suite.tar.gz), [patch](a00/proof-missing-suite.patch)                                                                                                | [Failed run](https://github.com/Azrkiel/xvant-agent/actions/runs/43367338919)                             |
| Initial corrected runner (PR) | Linux / Ubuntu 24.04       | **Passed**, 31 checks, 1,441 tests / 115 suites                | [Receipt](a00/ci-linux-qualified.json), [bundle](a00/ci-linux-qualified.tar.gz), [source admission](a00/ci-linux-qualified-ci-summary.json)                                                                        | [Qualified Linux job](https://github.com/Azrkiel/xvant-agent/actions/runs/43368644128/job/131699034967)   |
| Initial corrected runner (PR) | Windows 2025 / build 26100 | **Passed**, 31 checks, 1,441 tests / 115 suites                | [Receipt](a00/ci-windows-qualified.json), [bundle](a00/ci-windows-qualified.tar.gz), [source admission](a00/ci-windows-qualified-ci-summary.json), [journal probe](a00/ci-windows-qualified-journal-preflight.log) | [Qualified Windows job](https://github.com/Azrkiel/xvant-agent/actions/runs/43368644128/job/131699034676) |

[Machine-readable source/runtime/host index](a00/index.json), [job and artifact
metadata](a00/ci-jobs.json), and [criterion handoff](a00/handoff.md) provide the
provenance and limits. Source inventories and test/coverage JSON are inside each
bundle. The three negative proofs are separate Linux-only commits based on
`7bb00ad`; their failures are intentional and are not the PR head's result.
The diagnostic revision's Linux jobs were cancelled when the runner correction
was pushed; they are not qualification evidence.

Live providers/models, unattended operation, and hostile-code containment are
**not run / not qualified**. Linux and Windows passes qualify only the recorded
fixture hosts. Chromium's fixture launcher does not qualify browser sandboxing.

## Final readiness qualification

The records below supersede earlier positive runtime records. Historical failures
remain in the index and machine-readable records. All four push/PR platform jobs
passed on `febbb5f17515606886c6caec91005f9b3431ec55`, with source content hash
`e2c5a5bfd0bb20d5f298d126919deb52de924f0092c56d6e2687b26fc0d21127`.

| Observation                              | Platform             | Result                                              | Durable evidence                                                                                                                                               | CI                                                                                                          |
| ---------------------------------------- | -------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Corrected readiness                      | Linux / Ubuntu 24.04 | **Passed**, 31 checks, 1,444 tests / 115 suites     | [Receipt](a00/ci-linux-readiness.json), [bundle](a00/ci-linux-readiness.tar.gz), [source admission](a00/ci-linux-readiness-ci-summary.json)                    | [PR job](https://github.com/Azrkiel/xvant-agent/actions/runs/43371112543/job/131706944811)                  |
| Corrected readiness                      | Windows 2025         | **Passed**, 31 checks, 1,444 tests / 115 suites     | [Receipt](a00/ci-windows-readiness.json), [bundle](a00/ci-windows-readiness.tar.gz), [source admission](a00/ci-windows-readiness-ci-summary.json)              | [PR job](https://github.com/Azrkiel/xvant-agent/actions/runs/43371112543/job/131706945049)                  |
| Independent Windows push                 | Windows 2025         | **Passed**, 31 checks, 1,444 tests / 115 suites     | [Receipt](a00/ci-windows-readiness-repeat.json), [bundle](a00/ci-windows-readiness-repeat.tar.gz)                                                              | [Push job](https://github.com/Azrkiel/xvant-agent/actions/runs/43371106442/job/131706922445)                |
| Corrected local run                      | Linux / Debian 13.6  | **Passed**, 31 checks, 1,444 tests / 115 suites     | [Receipt](a00/readiness-linux-local.json), [bundle](a00/readiness-linux-local.tar.gz), [source admission](a00/readiness-linux-local-source-validation.json)    | Frozen local commit                                                                                         |
| Source changed during checks             | Linux / Debian 13.6  | **Failed / invalidated**, despite 31 passing stages | [Receipt](a00/readiness-source-changed.json), [bundle](a00/readiness-source-changed.tar.gz)                                                                    | Local source guard; not qualification                                                                       |
| Earlier parallel browser startup failure | Windows 2025         | **Failed**, despite passing 1,441 tests             | [Receipt](a00/ci-windows-browser-failed.json), [bundle](a00/ci-windows-browser-failed.tar.gz), [red delayed-page regression](a00/browser-readiness-before.log) | [Earlier failed push job](https://github.com/Azrkiel/xvant-agent/actions/runs/43368639732/job/131699032575) |

The early browser fixture discarded the exception detail, so the exact boundary
of that historical startup failure cannot be recovered. The delayed-page defect
was reproduced deterministically and corrected within the original launch deadline;
new fixture diagnostics preserve redacted error messages. See the handoff for the
full limitation and the distinction between source-invalidated and qualified runs.
