# A00 — Reproducible baseline and continuous verification

Status: planned. Prerequisites: none. Read [the overall plan](README.md) first.

## Outcome and scope

Any implementing agent can reproduce the current baseline, run relevant checks, and publish evidence tied to the exact source. CI distinguishes offline fixtures, real-browser tests, and explicitly authorized live provider qualification. Establish this before architecture changes so regressions remain attributable.

Inspect `package.json`, `.node-version`, `scripts/gate.mjs`, `scripts/gate-policy.ts`, `scripts/evidence-bundle.ts`, `scripts/browser-path.ts`, and existing release scripts. The baseline has no checked-in GitHub Actions workflow. Historical plan claims and local-only receipts are not substitutes for a new run.

## Execution

1. Inventory required tools, runtime pins, host assumptions, native SQLite installation, browser availability, and process supervision. Capture a reproducible Linux runner definition; preserve Windows validation separately.
2. Add CI on pushes and PRs with read-only default credentials. Untrusted PR code must not receive live account credentials or elevated publication permissions. Configure runtime, Chromium, OpenSSH, and proper child reaping explicitly.
3. Run the full offline gate with bounded execution and retain failure logs, test results, coverage, source manifests, and receipts. Missing tests, skipped required tests, unavailable browsers, or failed coverage remain failures.
4. Define a small fast feedback command if useful, but keep its claims distinct from the integrated gate. Pin meaningful suite discovery and update minimums when coverage is added.
5. Publish a supported-host/toolchain guide and evidence index. Record retention and archival rules so release evidence remains available after CI artifact expiration.
6. Describe a separately invoked live qualification route, credential setup, permitted providers, and budget controls. A normal source PR must not trigger paid or external model activity implicitly.

## Success criteria

- **A00-C1:** A clean documented runner installs and passes the baseline gate without developer-local files.
- **A00-C2:** CI exercises the submitted revision and identifies its source hash; missing or failing required checks fail the job.
- **A00-C3:** A deliberate failing fixture produces a failed job and useful retained evidence; an unavailable browser cannot produce a green result.
- **A00-C4:** No live calls or write credentials are needed for ordinary PR checks.
- **A00-C5:** Linux and Windows results are labeled independently. Reaping/setup defects are documented and corrected in the runner.
- **A00-C6:** An evidence index links commands, source, runtime, results, and known limits, without secrets.

## Validation and latitude

Exercise a clean install and a controlled failed run as well as success. Check the actual GitHub workflow result when publication/execution is available; YAML validation alone does not qualify CI. If workflow publication is blocked by connector permissions, prepare and validate the files and report that exact incomplete outcome.

Choose caching, job decomposition, and artifact formats. Do not cache mutable task databases or replace failures with retries-until-green. Known flakes need a diagnosis and explicit evidence. Avoid unrelated test-count expansion.

## Deliverables and handoff

Workflow and runner configuration, reproducibility guide, evidence index, and observed baseline results. Map C1–C6 to evidence using the overall handoff template. A01 consumes the resulting validation commands and evidence conventions.
