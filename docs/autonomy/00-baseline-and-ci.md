# A00 — Reproducible checks and CI

Status: planned. Completion prerequisites: **None**.
Read [the overall plan](README.md) and this subplan before editing.

## Deliverable

A new contributor or CI runner can install XVANT, run the full offline gate, and retrieve source-bound results without developer-local files.

## Start here

Inspect `package.json`, `.node-version`, `scripts/gate.mjs`, `scripts/gate-policy.ts`, `scripts/evidence-bundle.ts`, `scripts/browser-path.ts`. These are starting points, not required locations for new code. Verify prerequisite outcomes and current repository instructions before implementing.

**First useful change:** Reproduce the baseline. Finish work package 1 before broadening the implementation. Each package can be one or more reviewable PRs.

## Work in this order

### Work package 1: Reproduce the baseline

Start from a clean checkout. Identify the Node/npm pins, SQLite installation behavior, Chromium, OpenSSH, and child reaping requirements. Run the full offline gate and diagnose environmental failures.

**Deliver:** A repeatable runner/setup guide and an observed clean-run receipt.

### Work package 2: Run that setup in CI

Add a PR/push workflow with read-only default credentials, bounded execution, and retained test/coverage/log artifacts. Missing tests and unavailable required tools must fail the job. Keep live calls separate.

**Deliver:** A workflow that has actually run on the submitted revision, plus success and controlled-failure evidence.

### Work package 3: Make results usable later

Add an evidence index with source/runtime/host details and retention rules. Label Linux and Windows qualification separately. Document a separately authorized live qualification route.

**Deliver:** Stable evidence links and a guide another agent can follow.

## Acceptance checklist

Mark a criterion passed only when the handoff links to its command or artifact and observed result. These IDs are preserved from plan version 1 so existing references remain valid.

- [ ] **A00-C1:** A clean documented runner installs and passes the baseline gate without developer-local files.
- [ ] **A00-C2:** CI exercises the submitted revision and identifies its source hash; missing or failing required checks fail the job.
- [ ] **A00-C3:** A deliberate failing fixture produces a failed job and useful retained evidence; an unavailable browser cannot produce a green result.
- [ ] **A00-C4:** No live calls or write credentials are needed for ordinary PR checks.
- [ ] **A00-C5:** Linux and Windows results are labeled independently. Reaping/setup defects are documented and corrected in the runner.
- [ ] **A00-C6:** An evidence index links commands, source, runtime, results, and known limits, without secrets.

## Test these scenarios

These scenarios are a minimum starting set; the acceptance checklist remains binding. Add other cases needed to cover the actual implementation.

| Scenario             | Setup/action                                                      | Required observation                                                |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Clean runner         | Install and run the baseline gate without local developer assets. | All required checks pass; the receipt identifies the actual source. |
| Required check fails | Use a disposable failing case or omit the required browser.       | The run fails and preserves useful diagnostics.                     |
| Ordinary PR          | Inspect credentials, permissions, and invoked commands.           | No live account or write credential is required.                    |

Use the overall plan's validation rules and required integrated gate. Record fixture and live results separately. Select any environment-specific timing/resource thresholds before running the measurement.

## Design freedom

Choose workflow jobs, caches, and artifact formats. Do not cache mutable project state or retry failures until they disappear. If workflow publication is unavailable, report CI execution as blocked rather than claiming it passed.

## Finish and hand off

List completed work packages and the result/evidence for every A00-C criterion. Document interface changes, migration/rollback, remaining limitations, and the next useful task. Update this milestone's row in the [overall plan](README.md). If any required criterion is partial, blocked, or not run, keep the milestone incomplete. Follow the shared handoff requirements in the overall plan.
