# XVANT phase gates and release evidence
Date: 2026-09-26
Status: superseded 2026-09-30. Current per-gate status (offline/live/Linux, with evidence bundles) is in [2026-09-30-verification-register.md](2026-09-30-verification-register.md). The requirements below still apply.
Parent: 2026-09-26-xvant-implementation-plan.md

## What a gate means
A passed gate links to reproducible evidence for a particular source revision and environment. A plan, mock result, model opinion, or skipped check cannot substitute for an execution receipt.

Gate states:
- not_run: no qualifying attempt.
- passed: all required checks ran and passed against the recorded revision.
- failed: at least one required check ran and failed.
- blocked: a required environment/account/capability is unavailable, with the exact reason recorded.

Evidence locations (G01 and development compatibility exist; other phase reports remain future work):
- docs/evidence/G00.json through docs/evidence/G10.json.
- docs/evidence/compatibility.json.
- docs/evidence/benchmark-v1.json.
- Redacted logs and test artifacts referenced by content hash.

Gate report fields:
- gateId, status, generatedAt, sourceRevision, dirtyTreeHash.
- operatingSystem, executionHost, Node/npm/Git versions.
- adapter versions, runtime versions, model IDs when involved.
- checks: command, workingDirectory, startedAt, finishedAt, exitCode, expectedCount, observedCount.
- artifact references and hashes.
- offline/live classification and account auth category without credentials.
- failed/skipped/blocked checks and reasons.
- reviewer findings, dispositions, and any explicitly accepted lower-severity limitations.
- rollbackProcedure and lastKnownGoodVersion.

## Phase gate register

| Gate | Required result | Current state |
| --- | --- | --- |
| G00 | Versioned compatibility matrix and billing/auth scope recorded | see register |
| G01 | Offline domain/simulator invariants pass | see register |
| G02 | Durable recovery, ownership, process control, local API boundaries pass | see register |
| G03 | Enabled adapters pass offline contracts and live 2/3/5 roster demonstration | see register |
| G04 | Cross-runtime context handoff preserves required evidence and privacy | see register |
| G05 | Original tools/skills enforce capabilities and pass fixtures | see register |
| G06 | Bounded hierarchy and parallel integration work without stale acceptance | see register |
| G07 | Complete local UI workflow passes accessibility and failure scenarios | see register |
| G08 | Native loop passes offline contract and live local-model qualification | see register |
| G09 | Baselines and candidates produce honest held-out evaluation results | see register |
| G10 | Clean installation, recovery, security, packaging, and evidence review pass | see register |

## Runtime compatibility checklist

For each Codex, Claude, and OpenCode adapter:
- [ ] Executable/server identity and exact version recorded.
- [ ] Normalized identity includes host, runtime, session, and run.
- [ ] Official login route used; no token export or copying into XVANT.
- [ ] Auth category and billing visibility recorded; unknown values remain unknown.
- [ ] Session creation and explicit continuation verified.
- [ ] Events route correctly across two concurrent sessions.
- [ ] Cancellation behavior measured and terminal state confirmed.
- [ ] Restart/reconnect behavior measured; ambiguity remains needs_attention.
- [ ] Native tool permissions and subagent controls tested.
- [ ] Model availability discovered rather than hard-coded.
- [ ] Unsupported capabilities are hidden or clearly disabled.
- [ ] External tools/API fallbacks cannot silently change billing mode.
- [ ] Attached read-only mode cannot send prompts or approvals.
- [ ] Imported history is labeled historical and does not imply live control.
- [ ] Provider errors redact sensitive content.

## Standards for every meaningful change

Before coding:
- [ ] Behavior and failure paths are clear.
- [ ] Relevant phase and requirement IDs are identified.
- [ ] External protocol/version details are checked.
- [ ] Diagram covers success, invalid input, empty input, and upstream failure.
- [ ] Test fixture does not contain personal data or secrets.

Before marking the change complete:
- [ ] Relevant failing behavior was reproduced for substantial behavior changes.
- [ ] Targeted tests pass with a nonzero discovered count.
- [ ] Type checks and lint pass.
- [ ] Affected integration boundaries are exercised.
- [ ] User-visible behavior is inspected in the runtime where possible.
- [ ] Correctness review is complete.
- [ ] Security and permission boundaries are reviewed.
- [ ] Duplication, coupling, and unnecessary complexity are reviewed.
- [ ] Important findings are fixed and affected tests rerun.
- [ ] Exact command results, revision, and limitations are recorded.
- [ ] No unrelated user changes are overwritten.
- [ ] The completion statement matches the actual evidence.

## Recovery acceptance campaign

Inject a controller/process failure at each boundary:
- [ ] Before task transaction commit.
- [ ] After task commit, before dispatch-intent consumption.
- [ ] After recording dispatching, before transport send.
- [ ] After send, before native acknowledgement.
- [ ] After acknowledgement, before persisting native run ID.
- [ ] During streamed output.
- [ ] After worker completion, before result persistence.
- [ ] During artifact temp-file write.
- [ ] After artifact rename, before metadata commit.
- [ ] During integration of a patch.
- [ ] During verification.
- [ ] During approval and cancellation races.
- [ ] During database migration.
- [ ] During backup and restore validation.

For each injection verify:
- [ ] There is no automatic duplicate execution when the outcome is uncertain.
- [ ] Task and attempt ownership remain consistent.
- [ ] Existing artifacts and unrelated user changes survive.
- [ ] UI shows the actual known state.
- [ ] Reconciliation is repeatable and does not itself relaunch the operation.
- [ ] No unrelated process is terminated.
- [ ] SQLite integrity and foreign-key checks pass.
- [ ] The event history explains how the resulting state was reached.

## Security and privacy acceptance campaign

These are product checks, not promises of perfect isolation:
- [ ] Loopback API rejects unauthorized requests, foreign Origins, and unexpected Host headers.
- [ ] Cookie/CSRF controls prevent browser-origin mutation from unrelated pages.
- [ ] Tool identifiers and parameters are validated before execution.
- [ ] Repository text and tool output cannot change permissions or billing.
- [ ] Windows case variations, spaces, Unicode, UNC paths, device paths, junctions, and symlinks are covered.
- [ ] File write checks handle time-of-check/time-of-use races through the selected execution boundary.
- [ ] Shell command arguments are passed structurally; raw shell mode is a separate explicit capability.
- [ ] Native vendor tools do not bypass the claimed XVANT policy profile.
- [ ] Agent skills cannot execute arbitrary lifecycle hooks without registered permission.
- [ ] Approval is bound to action hash, workspace, task scope, expiry, and version.
- [ ] Credential files are excluded from context and diagnostics.
- [ ] Secret sentinels are absent from persisted logs and exports.
- [ ] Browser tooling uses a dedicated profile.
- [ ] Memory cannot cross project boundaries without explicit sharing.
- [ ] Attachments and artifacts render as untrusted content.
- [ ] Dependencies and reused code have recorded license obligations.

## UI acceptance campaign

- [ ] A first-time user can register a repository and a supported runtime.
- [ ] Unavailable OpenCode or other runtime is shown with a setup state, not a fake worker.
- [ ] Ten named instances can be distinguished at a glance.
- [ ] A user can reference a worker and inspect the resolved target.
- [ ] Connected, idle, running, waiting, stopping, disconnected, and unknown are distinct.
- [ ] Double submit creates one task.
- [ ] Back navigation/reload restores state without resubmitting work.
- [ ] Slow connections preserve pending state.
- [ ] SSE reconnection recovers missed transitions.
- [ ] Long output cannot freeze the interface or grow memory without bound.
- [ ] Pause/cancel show acknowledgement and remaining uncertainty.
- [ ] Global stop is always reachable.
- [ ] Review shows the exact artifact/revision being accepted.
- [ ] Failed or stale evidence prevents acceptance.
- [ ] All core workflows are keyboard accessible.
- [ ] Focus remains predictable after dialogs and streamed updates.
- [ ] Status and error information do not rely only on color.
- [ ] Empty/error/offline states explain the next available action.

## Evaluation acceptance campaign

- [ ] Acceptance checks are frozen before runs.
- [ ] Baselines use the same starting repository and task limits.
- [ ] Model/runtime/skill versions are recorded.
- [ ] Failed attempts count in results.
- [ ] Quota-interrupted runs remain incomplete or failed according to a predeclared rule.
- [ ] Hidden tests are not injected into worker context.
- [ ] Tuning and held-out tasks are separate.
- [ ] Unknown token/cost data is not fabricated.
- [ ] Small-sample results are labeled directional.
- [ ] Candidate promotion retains the previous version.
- [ ] Core self-improvement goes through an isolated patch and normal checks.

## Release profiles

local-beta:
- Requires G00 through G07 and the relevant G10 installation/recovery checks.
- Native-loop features and learning remain disabled or explicitly experimental.
- Live support claims are limited to adapters that passed G03.
- Does not claim all original-product requirements are complete.

local-v1:
- Requires G00 through G10, including live G08 qualification for native execution.
- Requires R01 through R16 traced to evidence.
- Requires the ten-instance roster; ten concurrently executing workers is separately labeled if quota prevented that stress test.
- No unresolved critical or high-impact correctness/security finding.
- Lower-severity limitations have an owner, impact statement, and workaround.
- Subscription-only billing is claimed only for individually verified routes and known account settings; otherwise display unverified.
- Publishing/distribution is separate from building and locally validating release artifacts.

## Planning-bundle audit

Planning checks performed on the documents are separate from all implementation gates:
- Every requirement maps to at least one phase.
- Every phase has an entry dependency, numbered tasks, a gate, and expected check output.
- Failure scenarios have named detection and recovery behavior.
- Deferred work is explicit.
- The first implementation slice defines its types, tests, implementation, and expected red/green results.
- The first-slice snippets passed a limited Node assertion-harness audit: 15 intended red-stage failures, then 15 green-stage passes. Vitest, compiler typechecking, dependencies, application runtime, and all live integrations remain unverified.

