# XVANT implementation plan
Date: 2026-09-26
Status: Phase 2 offline implementation is present; see ../phase-02-progress.md and ../evidence/G02.json for host-qualified verification. Linux and live-provider qualification remain open.
Owner: the user. Implementation: Codex, following the gates below.
Repository target: C:\Users\jiang\XVANT

## Goal
Build an original local agent application that coordinates named Codex, Claude Code, and OpenCode workers, supplies its own tools and engineering skills, preserves evidence across handoffs, and improves through measured evaluation.

## Architecture
XVANT owns the user interface, task state, scheduler, context, tools, skill catalog, verification, and learning. External coding runtimes remain replaceable execution backends; a later native XVANT execution loop supports local models. A deterministic controller owns dispatch and permissions while models propose plans, execute bounded tasks, and review results.

## Technology decisions
- Language: TypeScript with strict checks, ESM, and explicit runtime validation at external boundaries.
- Runtime target: Node.js 24 LTS, subject to the compatibility checks in Phase 0. Pin the exact passing patch release in the repository and release manifest.
- Build: npm workspaces and a committed package-lock.json; npm ci for reproducible installation.
- Backend: a local Node service with Fastify, JSON commands, and server-sent events (SSE). No internet-facing listener in v1.
- UI: React, Vite, semantic HTML, CSS variables, and a small component library authored for XVANT.
- Storage: SQLite through better-sqlite3, WAL on a local disk, transactional migrations, immutable artifact files. Validate the native binary on Windows before adopting it.
- Validation: Zod at API/config/adapter boundaries; JSON Schema exported for tools and skills.
- Tests: Vitest, fast-check for scheduler/state invariants, Playwright for UI and browser tools.
- Protocols: provider-specific adapters; MCP for XVANT tools and selected external tool servers.
- Packaging: a local service and browser UI first; a desktop shell is an explicitly deferred release.
- No Hermes or ECC runtime dependency. Original implementation and original bundled skills. Reused third-party library code retains its license and attribution.

All dependency versions are selected and pinned during Phase 0 after compatibility probes. This is an explicit verification task, not permission to silently choose latest versions during later phases.

## 1. Accepted scope and limits

The product is named XVANT. It is for one user on one machine initially. It must support a registry containing two Codex instances, three Claude Code instances, and five OpenCode instances. Registry size and active execution count are different settings.

The target experience:
1. Select a repository and describe a desired outcome.
2. XVANT records acceptance criteria and builds a proposed task graph.
3. Choose named workers or allow explainable routing.
4. XVANT prepares isolated workspaces and focused context.
5. Workers implement, investigate, test, or review within assigned scope.
6. XVANT integrates outputs, verifies the exact combined revision, and shows the result.
7. Keep the accepted patch, request another attempt, or stop. Publish and deploy are separate, explicitly authorized operations.

Two backend classes:
- External runtime backend: XVANT orchestrates Codex, Claude Code, or OpenCode. Their internal model/tool loop remains theirs.
- Native backend: XVANT runs its own model/tool loop. The first such backend targets an explicitly configured local model; paid model APIs are optional future work.

Subscription-first is a requirement, not a proven entitlement. Do not implement a replacement model API by copying vendor credentials. No automatic paid API fallback, quota evasion, account rotation, or unsupported credential extraction. Unknown usage is shown as unknown. Account-level overage settings cannot be guaranteed by an application that cannot inspect them.

Originality means owning the product and core behavior. It does not mean rewriting SQLite, Git, browser engines, or cryptography.

## 2. Measurable release outcomes

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| R01 | Ten addressable workers: 2 Codex, 3 Claude, 5 OpenCode | Live roster with unique worker/session identities and independently recorded outcomes |
| R02 | Explicit references such as @codex-1 and @claude-2 | Address resolution tests, duplicate-name rejection, visible target before dispatch |
| R03 | Shared context across runtimes | Handoff fixture preserves requirements, revision, artifacts, decisions, and open questions |
| R04 | Parallel work without silent overwrites | Separate worktrees, overlap detection, serialized integration, combined-revision tests |
| R05 | Adaptive hierarchy | Small task stays single-worker; separable task expands within depth and count limits |
| R06 | Original tools and skills | Versioned manifests, executor permissions, deterministic tests, original workflow text |
| R07 | Subscription-first execution | Per-account auth/billing compatibility evidence; API fallback disabled and tested |
| R08 | Recovery | Controller kill/restart at dispatch checkpoints creates no blind duplicate operation |
| R09 | User control | Pause, cancel, resume, instance disconnect, approval, and global stop behavior demonstrated |
| R10 | Verification before completion | No accepted task without required evidence tied to its exact artifact/revision |
| R11 | Local privacy | No telemetry by default; redacted exports; secrets excluded from retrieval and logs |
| R12 | Improvement based on evidence | Baseline comparison and versioned candidate promotion with rollback |
| R13 | Windows support | Native Windows core passes path/process/package tests; execution capability limits are explicit |
| R14 | Existing-session access | Read/import/attach/resume distinguished; live attachment only where verified |
| R15 | Native XVANT agent loop | Local-model adapter executes a bounded tool loop and passes the common runtime contract |
| R16 | Operable product | Backup/restore, diagnostics, version compatibility, accessibility, and release checklist pass |

Targets are design requirements until demonstrated. Do not advertise improvement over Hermes, ECC, or a single agent without controlled measurements.

Requirement-to-gate trace:
| Requirement | Primary gates |
| --- | --- |
| R01 | G03, G06 |
| R02 | G03, G07 |
| R03 | G04 |
| R04 | G06 |
| R05 | G06 |
| R06 | G05 |
| R07 | G00, G03, G10 |
| R08 | G02 |
| R09 | G02, G07 |
| R10 | G01, G06 |
| R11 | G02, G04, G05, G10 |
| R12 | G09 |
| R13 | G00, G10 |
| R14 | G03 |
| R15 | G08 |
| R16 | G07, G10 |

## 3. Architecture and data flows

```text
[User: request + repo + policy]
               |
               v
[Validate and persist command] --invalid/empty--> [Explain field error]
               |                    |
               |                 disk error
               |                    v
               |              [Stop admission]
               v
[Planner proposes task graph] --invalid/cyclic--> [Repair once or request clarification]
               |
               v
[Deterministic scheduler] --quota/capacity--> [Wait with reason]
               |         --permission------> [Approval required]
               |         --missing runtime-> [Setup required]
               v
[Context + pinned skills + workspace lease]
               |
               v
[Durable dispatch intent] --> [Adapter supervisor] --> [Named worker]
                                     |                    |
                                 disconnect          output/events
                                     |                    |
                                     v                    v
                              [Reconcile run]      [Validated evidence]
                                     |                    |
                              unknown outcome       [Integration queue]
                                     |                    |
                                     v                    v
                              [Needs attention]     [Tests + review]
                                                          |
                                               pass ------+------ fail
                                                |                  |
                                                v                  v
                                          [Ready for user] [Bounded repair]
                                                |
                                                v
                                       [Accepted artifacts]
                                                |
                                                v
                                   [Candidate skill / routing update]
                                                |
                                          [Offline evaluation]
                                                |
                                     [Promote or retain current]
```

Control and execution are separate:
- The controller owns task state, approval state, budgets, leases, and integration.
- Adapters own vendor translation, connection state, session identity, and cancellation.
- Workers receive task-scoped context and return claims plus artifacts.
- Policy is enforced in code and by the selected execution sandbox, not by a prompt.
- The UI is a client of the controller. Closing the browser does not mean cancelling a task.
- A planner/lead is a role assigned to an existing worker, not an extra free model call.

Allowed dependency direction:
```text
UI -> shared contracts
Controller -> core + storage + scheduler + context + tools + skills + adapters
Adapters -> shared contracts + vendor SDK/protocol
Core -> shared contracts only
Tools -> execution host + policy + shared contracts
Evaluation -> public APIs + fixtures (never runtime business-logic imports)
```
No vendor SDK imports in the scheduler, UI, memory, or task domain.

## 4. File and module ownership map

Paths below are future repository-relative paths under C:\Users\jiang\XVANT. Only this plan bundle exists at planning time.

| Path | Responsibility |
| --- | --- |
| package.json, package-lock.json, tsconfig.base.json | Workspace commands, dependency pins, compiler rules |
| apps/controller/src/main.ts | Local service lifecycle, graceful shutdown, composition root |
| apps/controller/src/http/commands.ts | Validated idempotent commands; no business rules in route handlers |
| apps/controller/src/http/events.ts | SSE cursor replay, authentication, bounded streaming |
| apps/controller/src/http/auth.ts | Loopback access, session cookie, CSRF, Origin and Host checks |
| apps/controller/src/http/views.ts | Redacted task, worker, and artifact views |
| apps/web/src/features/tasks/ | Composer, task tree, evidence, pause/cancel controls |
| apps/web/src/features/workers/ | Named workers, status, capabilities, ownership mode |
| apps/web/src/features/review/ | Diff, checks, findings, accept/rework actions |
| apps/web/src/features/settings/ | Runtime discovery, quota groups, tools, privacy, skills |
| packages/contracts/src/ | Versioned schemas, identifiers, errors, commands, events |
| packages/core/src/ | Task/attempt states, pure transitions, invariants |
| packages/storage/src/ | SQLite repositories, migrations, transactional outbox, artifact store |
| packages/scheduler/src/ | DAG validation, leases, dispatch, admission, cancellation |
| packages/supervisor/src/ | Worker processes, heartbeats, platform termination, reconnect |
| packages/adapters/src/codex/ | Codex protocol bridge, version probes, event normalization |
| packages/adapters/src/claude/ | Claude SDK worker bridge and explicit session resume |
| packages/adapters/src/opencode/ | Server/session bridge, endpoint identity and events |
| packages/adapters/src/simulated/ | Deterministic worker for tests; never reported as live |
| packages/context/src/ | Retrieval, packet building, token estimates, invalidation |
| packages/memory/src/ | Namespaced knowledge, provenance, proposals and accepted facts |
| packages/workspaces/src/ | Repository snapshots, worktree leases, integration and cleanup |
| packages/policy/src/ | Effective permissions, approval matching, quota admission |
| packages/tools/src/ | Tool catalog, typed executors, MCP bridge, receipts |
| packages/skills/src/ | Manifest validation, selection, pinning, lifecycle hooks |
| packages/verification/src/ | Check plans, test receipts, review findings, acceptance |
| packages/native-agent/src/ | XVANT-owned bounded model/tool loop and local model adapter |
| packages/evaluation/src/ | Baselines, benchmark runner, routing/skill candidate evaluation |
| skills/*/SKILL.md, skills/*/manifest.json | Original XVANT workflow instructions and capabilities |
| scripts/gate.mjs, scripts/check-docs.mjs | Gate execution and contract/document validation |
| tests/contracts/, tests/integration/, tests/e2e/, tests/faults/ | Behavior and boundary verification |
| fixtures/repos/, fixtures/events/, fixtures/benchmarks/ | Synthetic data with no personal credentials |
| docs/evidence/ | Redacted compatibility, phase, and benchmark reports |
| docs/decisions/ | Architecture decisions and superseded assumptions |
| docs/runbooks/ | Install, recover, back up, restore, diagnose, update |

Keep files cohesive. Split based on responsibility, not an arbitrary line-count target. Do not create all modules as empty scaffolds on day one.

## 5. Runtime identity and ownership

A worker record contains:
- Stable XVANT workerId and editable unique alias.
- runtimeKind: codex, claude, opencode, simulated, or native-local.
- hostId, runtime version, executable/server identity, and adapter version.
- Native conversation ID and active run ID as separate fields.
- Mode: managed, attached-readonly, attached-control, or imported.
- Workspace reference, role, pinned skills, permission profile, and quotaGroupId.
- Declared capabilities, tested capabilities, and last successful health check.

Rules:
1. Names are labels; persisted IDs route work. Renaming cannot change an in-flight destination.
2. Scope native session IDs to runtime and host. Do not assume IDs are globally unique.
3. Default to one in-flight mutation/turn per worker session.
4. One controller owns writes to a session. Attached control requires explicit ownership and a tested transport.
5. An imported transcript is historical context, never proof of a live controllable process.
6. A lost connection means unknown connectivity, not automatically a failed or finished task.
7. A PID alone is insufficient identity: record creation time, supervisor nonce, and connection identity.
8. A stale worker cannot commit results under a newer attempt's fencing token.
9. Aliases are project-visible; private context from other projects is not included by alias alone.
10. Read-only attachments never receive task prompts, tool approvals, or cancellation commands.

Initial pool:
```text
codex-1, codex-2
claude-1, claude-2, claude-3
opencode-1, opencode-2, opencode-3, opencode-4, opencode-5
```
Default active cap: 3, configurable up to 10 after live capacity testing. Default hierarchy: coordinator -> optional lead -> worker. Maximum tree nodes: 20 per root task; maximum depth: 3 role levels. Native subagents are disabled unless their work is registered and their consumption can be bounded.

## 6. Task, attempt, and operation states

```text
Task:
draft -> queued -> running -> verifying -> ready_for_acceptance -> accepted
           |          |           |
           v          v           v
        blocked     paused     needs_rework -> queued
           |          |
           +-> queued +-> queued

Any nonterminal task -> cancelling -> cancelled
Any unresolved run -> needs_attention -> explicit reconciliation decision
```

Attempt states: reserved, dispatching, running, interrupt_requested, succeeded, failed, cancelled, unknown.
A task can have multiple attempts, but only one live writing attempt for a given owned scope.
Successful worker output moves the task toward verification, never directly to accepted.
Failure and cancellation preserve artifacts. Paused tasks admit no new children.

Operation ledger: planned -> sent -> acknowledged -> completed; interruption before acknowledgement may produce unknown. Exactly-once execution of arbitrary shell commands or vendor requests is not promised.

Crash recovery:
```text
[Restart controller]
      |
[Acquire exclusive database/controller lock]
      |
[Read unfinished dispatch intents]
      |
[Query supervisor and adapter]
      +-- definitely not sent --> [Dispatch once under current lease]
      +-- still running -------> [Reattach and monitor]
      +-- finished ------------> [Import receipt and verify]
      +-- uncertain -----------> [needs_attention; do not resend]
```

Pause prevents new dispatch and asks active workers to stop at a checkpoint where supported. The UI shows pausing until acknowledgement; stopping a process is cancellation, not a guaranteed resumable pause.
Cancel requests propagate through children. A cancellation request is not completion. An unresponsive attached worker becomes needs_attention; XVANT never kills an unrelated external process.
A global stop blocks admission immediately and interrupts all XVANT-owned active runs.

## 7. Persistence, contracts, and protocol

Use SQLite WAL with foreign keys enabled and a bounded busy timeout. A single controller owns writes. Use explicit transactions for state transition + event + outbox insertion.

Tables:
- projects: canonical root, repository identity, execution host, privacy configuration.
- workers: stable identity, alias, adapter/host, capability report, quota group.
- sessions: worker/native-session mapping, ownership mode, last cursor.
- tasks: parent/root IDs, objective, acceptance definition, state, workRevision, and rowVersion. workRevision changes when the specification or accepted artifact set changes; rowVersion increments on every persisted mutation for optimistic concurrency.
- dependencies: prerequisite and dependent task IDs; graph acyclicity validated before commit.
- attempts: task, worker, workspace, fencing generation, native run, current state.
- operations: idempotency key, request hash, send/ack/result states.
- events: increasing local sequence, schema version, task/attempt identity, redacted payload.
- outbox: durable dispatch requests and reconciliation state.
- approvals: exact action hash, scope, revision, expiry, policy version, decision.
- leases: workspace/session owner and fencing generation.
- artifacts: content hash, media type, revision, creator, retention class.
- checks: command/spec hash, exit status, artifact hashes, environment and source revision.
- memories: namespace, provenance, confidence label, source revision, supersession.
- skill_versions: manifest hash, source, compatibility, evaluation state.
- usage_samples: source-reported or estimated metrics, timestamp, quota group.
- routing_decisions: candidates, exclusions, selected worker, policy version, observed outcome.

Schema rules:
- Unique idempotency key per project + command kind. A repeat with different payload returns CONFLICT.
- rowVersion supports optimistic concurrency; stale UI changes return CONFLICT with the current rowVersion. Verification receipts reference workRevision, tree hash, and artifact-set hash, so a status-only update does not invalidate otherwise current checks.
- Deduplicate native events with their native ID where supplied. If absent, preserve order and avoid manufacturing exactly-once guarantees.
- Artifacts are written to a temporary file, hashed, flushed, and atomically renamed before DB references become visible. Recovery removes unreferenced temp files only.
- Live databases stay off network shares and sync folders. Export a consistent SQLite backup plus a hash manifest for artifacts.
- Do not concatenate streamed text directly into trusted instructions or executable commands.

Command API, versioned under /api/v1:
| Method/path | Input | Result |
| --- | --- | --- |
| POST /projects | Validated local root and host | Project ID or PATH_DENIED |
| POST /workers | Runtime, mode, alias, connection reference | Worker ID + probe state |
| POST /tasks | Project, objective, criteria, policy, idempotency key | Task ID + rowVersion + workRevision |
| POST /tasks/:id/dispatch | Expected rowVersion, explicit worker or auto | Attempt ID or blocking reason |
| POST /tasks/:id/pause | Expected rowVersion | Pausing/paused state |
| POST /tasks/:id/resume | Expected rowVersion | Queued state or unresolved-operation error |
| POST /tasks/:id/cancel | Expected rowVersion | Cancelling state |
| POST /approvals/:id/decide | Action hash, decision, expected approval version | Recorded decision |
| POST /tasks/:id/accept | Expected rowVersion + verified workRevision + artifact hashes | Accepted state or STALE_EVIDENCE |
| GET /events?after=cursor | Authenticated local session | SSE replay then live events |
| GET /artifacts/:id | Project-scoped access | Safe content/download; no arbitrary path lookup |
| GET /diagnostics | Redacted runtime health | Version/capability report |

Events have schemaVersion, eventId, sequence, occurredAt, projectId, taskId, attemptId, kind, payload.
Event kinds include task.created, task.state_changed, worker.status_changed, attempt.started, attempt.output, attempt.finished, approval.requested, operation.unknown, artifact.created, check.completed, quota.blocked, and routing.selected.
Text deltas can be coalesced. State transitions and final receipts must not be dropped. On replay gaps, send snapshot_required and reload a consistent snapshot.

Adapter contract:
- probe(): versions, auth mode category, tested transport, available capabilities, unknown fields.
- createSession(spec): native session reference.
- readSession(ref): redacted history/status when supported.
- startTurn(ref, request, dispatchKey): native run reference or explicit unknown outcome.
- events(ref, cursor): normalized event stream with recoverability metadata.
- steer(ref, message): capability-gated in-flight input.
- interrupt(ref): acknowledgement, unsupported, or uncertain.
- reconcile(ref): not_started, running, completed, failed, or unknown.
- close(ref): release XVANT-owned connection without deleting user history.

Unsupported operations return CAPABILITY_UNSUPPORTED. Do not emulate resume by replaying an entire transcript as if it were native state.

## 8. Original tools, skills, and context

Tool manifests include name, version, JSON input/output schemas, effect class, required permissions, execution host, timeout, retry classification, and result size limit.
Effect classes: read, workspace-write, process, network, and external-write.
Each execution returns a receipt with task/attempt identity, action hash, timestamps, result, exit status where relevant, and artifact references.

Initial tools:
| Tool | Behavior | Required checks |
| --- | --- | --- |
| repo.search | Search approved root; structured matches | Ignore rules, binary detection, bounded results |
| file.read | Read allowed text range | Canonical path, symlink/reparse checks, encoding limits |
| file.apply_patch | Apply patch against expected file hash | Reject stale hash and out-of-scope paths |
| command.run | Execute approved program + argv in selected host | No shell-built user strings; bounded time/output |
| test.run | Execute repository-approved test command | Receipt includes revision and command hash |
| git.inspect | Status/diff/base metadata | No implicit stage, commit, reset, or clean |
| browser.inspect | Browser evidence in managed context | URL policy, isolated profile, no inherited personal cookies |
| artifact.publish | Store local immutable result | Namespace, size, content hash |
| agent.request_work | Submit bounded child task | Root limits, DAG validation, no recursive bypass |
| agent.read_result | Retrieve completed task evidence | Project scope and visibility |
| memory.search | Retrieve relevant sourced records | Namespace, confidence, revision relevance |
| memory.propose | Add a candidate record | Cannot change policy or verified facts directly |

A process launched with a restricted working directory is not a sandbox. Arbitrary commands and external runtimes need a tested execution boundary. Required permission profiles fail closed when that boundary is unavailable. A clearly labeled trusted-local mode may exist for user-approved work; it is not represented as isolation. For Windows, validate vendor sandbox behavior and/or use a separately registered WSL/container execution host. Never silently translate a Windows path into another host.

Localhost HTTP needs authentication, strict Host/Origin validation, CSRF protection, and no wildcard CORS. Bootstrap access uses a one-time capability, exchanged for an HttpOnly session cookie; do not put persistent secrets in URL history or logs. Render untrusted markdown without raw HTML. Tool results and repository documents are data and cannot grant privileges.

Skills have a manifest plus SKILL.md:
- id, version, description, input/output schema references.
- Required tools, supported runtime capabilities, maximum context allowance.
- Lifecycle steps and expected evidence.
- Evaluation fixture IDs, license/origin, content hash.
- Hooks declared as specific lifecycle actions; executable hooks require explicit registration and policy.
Original bundled skills: explore-repository, plan-change, implement-change, diagnose-failure, test-change, review-change, document-change, handoff-work, integrate-patches, and evaluate-skill.

Policy precedence:
1. Runtime/platform mandatory restrictions.
2. User-selected XVANT permission and budget policy.
3. Project constraints.
4. Task instructions.
5. Selected skill procedures.
6. Retrieved memory and tool output as untrusted context.
Conflicts are surfaced. No skill can widen permissions.

Context packet:
- Objective and immutable acceptance criteria.
- Base revision and current workspace revision.
- Relevant files with content hashes and provenance.
- Decisions with status: proposed, accepted, superseded.
- Pinned skill versions and allowed tools.
- Existing artifacts, known failures, and remaining questions.
- Recipient role, assigned ownership, context budget, source visibility.

Start with file search + symbol/path relevance + SQLite full-text search. Embeddings are deferred until a benchmark demonstrates need.
Never fill the budget by truncating acceptance criteria or policy. If required context exceeds the budget, split the task or request a larger supported budget.
Files such as credentials, .env secrets, and private keys are excluded by default. Redaction is defense in depth, not a guarantee that all secrets are detectable.
Provider-context caches and hidden reasoning are not portable. Native transcripts remain with their runtime unless explicitly imported as data.

## 9. Routing, hierarchy, workspaces, and integration

Router v1:
1. Filter workers by tested capabilities, project visibility, execution host, policy, and health.
2. Respect a valid explicit user assignment.
3. Prefer continuing a suitable existing session when switching would discard useful context.
4. Among eligible idle workers, use configured task-role preferences and observed outcomes.
5. Record selection and exclusions. If all are blocked, queue with reasons; never silently change billing mode.

No numerical model-confidence score is treated as verified quality. Promotion of learned routing requires evaluation.
Default retry budget: one transport reconnect attempt when no execution is duplicated; at most two repair attempts per leaf task. Resetting a session does not reset the root budget.

Hard local limits cover dispatch count, child count, active slots, and elapsed time. Model-turn/token ceilings are hard only where the adapter exposes enforceable limits; otherwise report them as estimates or unsupported. Stopping work cannot undo already billed inference. Two repairs means at most three execution attempts including the original. Subscription-mode financial reporting uses observed allowance data where available, never a fabricated per-token dollar bill.

Hierarchy:
- A planner proposes a DAG with objectives, deliverables, dependencies, ownership, and estimated effort.
- Validate it deterministically. Reject cycles, inaccessible resources, excessive depth, duplicate responsibilities, and missing acceptance checks.
- Leads coordinate interfaces; they cannot create unregistered grandchildren.
- Join operations are represented as dependencies, not agents blocking while holding scarce execution slots.
- A lead releases its worker slot while waiting. This avoids a pool full of waiting parents.
- Later peer assistance goes through the same scheduler and cycle detection.

Workspace rules:
- Snapshot dirty user work explicitly before a task; never reset or stash it without authorization.
- Each writer gets a Git worktree from a recorded base revision. Read-only agents get a snapshot/revision.
- External changes to an attached user's checkout suspend XVANT integration until reconciled.
- Non-Git folders use read-only analysis in v1; writable snapshot support is deferred.
- Process permissions and filesystem isolation are independent of Git worktrees.
- Workspace cleanup requires no live owner, reconciled operations, persisted artifacts, and a recoverable retention period.

Integration:
1. Queue completed patches with base revision and ownership metadata.
2. Apply one at a time to an integration worktree.
3. Conflicts become explicit tasks; no destructive reset to make them disappear.
4. Run acceptance checks against the combined tree.
5. Review the combined diff; a changed revision invalidates previous review/test evidence.
6. Present a recoverable patch/branch to the user. Main-branch merge, push, PR creation, and deployment are separately configured actions.

## 10. Implementation phases

Each numbered task is a reviewable work item, not a claim that it takes five minutes. Implementation uses small red/green steps within each item. The accompanying first-slice document provides the exact initial code/test sequence. Commit cohesive passing changes; do not create meaningless commits for every keystroke.

All commands below are planned interfaces. They become runnable as their owning task creates them. Expected outcomes are acceptance requirements, not results already observed.

### Phase 0 - Prove environment, interfaces, and billing assumptions
Depends on: this plan.
Deliverable: redacted compatibility report and pinned implementation baseline.

- [ ] P00.1 Inventory Node/npm/Git/runtime executable versions and real paths. Check clean installation independent of Hermes directories.
- [ ] P00.2 Probe Codex session creation, one bounded read-only task, event correlation, interruption, and session recovery using a temporary fixture repository.
- [ ] P00.3 Probe Claude SDK/headless execution with explicit session IDs and official local authentication; document the subscription/developer-guidance ambiguity.
- [ ] P00.4 Locate or install OpenCode only when implementation is authorized; probe server identity, two sessions, event delivery, and abort.
- [ ] P00.5 Record each capability as passed, failed, unavailable, or untested, with version and date.
- [ ] P00.6 Check the account's selected auth route and any visible overage configuration without reading or copying token files. Record unknown billing visibility explicitly.
- [ ] P00.7 Validate better-sqlite3, process termination, and Playwright on native Windows. If native execution requires WSL, define that host explicitly before Phase 2.
- [ ] P00.8 Pin dependencies, runtime versions, protocol schemas, and native ABI in docs/evidence/compatibility.json and docs/decisions/0001-platform.md.

Gate G00: the simulator path is ready; each live adapter has a truthful support record. A failed provider probe blocks that adapter's live claims, not offline development. Subscription-only live operation is not certified while billing/auth scope is unresolved.
Check: run node --version, npm --version, git --version, codex --version, claude --version, and opencode --version individually, then perform the bounded read-only native-interface probes in P00.2-P00.4. Save the outcomes in compatibility.json; a missing executable is an unavailable result, not a successful probe. Phase 0 does not assume an XVANT package or probe script exists. P03.1 adds npm run probe -- --runtime all --repo fixtures/repos/smoke --read-only to automate these checks, returning 0 for required passes, 2 for required unavailable capabilities, and 1 for failed probes. Inventory-only mode makes no model calls.
Rollback: remove only probe-owned processes/worktrees; retain redacted evidence.

### Phase 1 - Domain contracts and deterministic simulation
Depends on: platform baseline; live accounts not required.
Deliverable: a runnable offline task lifecycle.

- [x] P01.1 Establish npm workspaces, strict compiler config, Vitest, formatting, lint, and CI on Windows/Linux.
- [x] P01.2 Implement identifiers, task/attempt schemas, typed errors, and legal state transitions.
- [x] P01.3 Implement DAG validation and ancestor/depth limits using explicit data contracts.
- [x] P01.4 Implement a simulated adapter with success, failure, delayed output, malformed output, quota, and unknown-outcome scenarios.
- [x] P01.5 Implement in-memory orchestration of create -> dispatch -> evidence -> verification -> ready.
- [x] P01.6 Add scripts/gate.mjs with machine-readable gate reports and a minimum expected test count per suite.

Gate G01: illegal transitions, duplicate identities, cycles, and unverified acceptance are rejected; simulator output is unmistakably labeled simulated.
Check: npm run gate -- --phase 01 --offline.
Expected: exit 0, nonzero discovered tests, all scenario assertions pass. See the first-slice document for exact initial tests.

Phase 1 result (2026-09-26): P01.1–P01.6 are implemented. G01 passed locally on Windows with 110 Vitest tests, strict types, lint, formatting, coverage, and the runnable demo. Overall branch coverage was 94.19%. See `../evidence/G01.json` and `../phase-01-progress.md`. Linux CI is configured but has not run; live providers are unqualified.

### Phase 2 - Durable state, supervisor, and execution boundaries
Depends on: G01.
Deliverable: restart-safe controller with a managed worker lifecycle.

- [x] P02.1 Implement SQLite migrations and transactionally persist commands, state, events, and outbox rows.
- [x] P02.2 Implement hashed artifact writes, replay cursors, and optimistic task revisions.
- [x] P02.3 Add controller exclusivity, workspace/session leases, and fencing generations.
- [x] P02.4 Add cross-platform worker supervision, identity validation, bounded output, timeouts, and graceful/forced termination of owned process trees.
- [x] P02.5 Implement operation reconciliation and needs_attention for ambiguous outcomes.
- [x] P02.6 Add authenticated loopback API, CSRF/Origin/Host checks, redacted error responses, and command idempotency.
- [x] P02.7 Implement permission profiles against tested execution hosts; report unsupported enforcement rather than silently relaxing it.
- [x] P02.8 Implement consistent backup/restore and failed-migration recovery.

Implementation notes from Phase 1, to apply within P02.1–P02.8:

- Start P02.1 with a failing restart test. Command, state, event, and outbox intent commit together or not at all. Keep `packages/core` pure.
- Persist normalized outcome reasons (`quota`, `worker_failed`, `invalid_event`, `unknown`, `verifier_failed`, `cancelled`). Phase 1's `needs_attention` state alone loses the cause; ambiguous dispatches must not retry automatically.
- Preserve receipt provenance. Registered controller checks mint receipts bound to task, attempt, `workRevision`, tree hash, and artifact-set hash; persisted worker output cannot mint or alter them.
- Keep the controller's expected identity separate from adapter requests. A Phase 1 regression caught request mutation. Future transports validate against durable dispatch intent and fencing generation.
- Add hard deadlines and owned-process shutdown. Trusted in-process callbacks in Phase 1 can hang; an `AbortSignal` is insufficient for external workers.
- Qualify the SQLite driver and native ABI on Windows/Linux. `npm ci --ignore-scripts` passed for Phase 1 but may block native SQLite installation. Review and allow only needed build scripts.
- Inject crashes at commit, send, acknowledgement, and result boundaries. Keep uncertain operations visible for reconciliation.
- In Phase 3, map provider-native session IDs separately from XVANT's bounded internal IDs; do not assume native IDs fit the Phase 1 grammar.

Gate G02: crash injection before/after dispatch acknowledgement never blindly repeats an uncertain operation. Forged/stale worker results cannot modify current task state.
Check: npm run gate -- --phase 02 --offline.
Expected: all transaction, auth, lease, recovery, and process tests pass; DB integrity check is ok after each injected crash.
Rollback: restore the prior consistent backup; preserve newer artifacts for inspection; do not downgrade a live DB in place.

### Phase 3 - Codex, Claude Code, and OpenCode adapters
Depends on: G02 and each provider's passing G00 probe.
Deliverable: named, independently controllable live workers.

2026-09-28 progress: Offline OpenCode session creation and atomic binding are committed through `fb12631` in `C:\Users\jiang\Downloads\xvant\xvant-agent` on `codex/phase-3-offline`. Claude creation/resume launch options are committed as `e912d77`, following a fresh passing offline G03 run. Final G03 passed 604 tests with zero failures/skips, coverage, types, lint, format and all runtime checks, including created-session completion/interruption for both providers. Claude creation validates a host-selected UUID, reserves it directly and persists constrained launch options before starting its fixed peer; resume records an explicit session rather than an implicit latest session. Mixed create/resume, continue/fork and broader permissions are rejected. A fresh ownership check prevents launch after stop or takeover. Eight new actual-process crash cases cover create/resume before/after launch-intent persistence and startup, retaining reservations without replay. First-turn metadata must match the reserved session/root; no native create RPC is invented. OpenCode retains its provisional-to-returned atomic binding path. These remain offline projections; no SDK/model/history/auth operation runs. Next: authenticated endpoint ownership, explicit native interrupt admission and broader events. Live integration, product review, quota admission and Linux evidence remain open. All Phase 3 checkboxes remain open until full live acceptance criteria pass. See `packages/adapters/README.md` and local handoff `../../.Codex/handoffs/2026-09-28-2308.md`.

2026-09-28 update: `72893af` replaces scenario-driven Claude/OpenCode interruption with host-only admission (`OfflineNativeController.interrupt`). The journal commits actor, generation and an audit event before the interrupt frame is sent, refuses admission before dispatch or after a terminal result, and refuses `completed` after admission. G03 passed 628 tests pre-commit. Codex interrupt admission, endpoint authentication, broader events and live qualification remain open.

2026-09-29 update: `40d3096` Codex interrupt admission; `ed1b57f` native failure normalization with account-group admission blocks (P03.7/P03.8 offline); `28b671e` 2/3/5 roster through the owned controllers (P03.6 offline); `a704bce` owned authenticated OpenCode loopback endpoint over real HTTP/SSE (P03.4 offline). Pre-commit G03 passed 713 tests. Checkboxes stay open until live acceptance; live auth approval, Linux evidence and P03.5 remain.

- [ ] P03.1 Implement adapter capability/version negotiation, scripts/probe.mjs, and a reusable conformance suite; expose npm run probe with explicit read-only/live flags and per-provider evidence.
- [ ] P03.2 Implement Codex managed process, explicit thread/run mapping, event stream, steering, interruption, and reconciliation.
- [ ] P03.3 Implement Claude SDK worker isolation, explicit session mapping, structured results, permission callbacks, cancellation, and resume.
- [ ] P03.4 Implement OpenCode server/session mapping, authenticated local endpoint configuration, async prompts, event correlation, and abort.
- [ ] P03.5 Add managed versus attached ownership modes and capability-gated history import.
- [ ] P03.6 Create the 2/3/5 worker roster and validate that outputs, errors, approvals, and cancellation route to the correct instance.
- [ ] P03.7 Normalize auth-required, quota-limited, unavailable-model, unsupported-version, and uncertain-run conditions.
- [ ] P03.8 Group quota consumption by account across runtimes; distinguish measured, estimated, and unknown usage.

Gate G03: every enabled live adapter passes its contract suite. The 2/3/5 roster is demonstrated with independent sessions; fake tests cannot substitute for live support.
Check: npm run gate -- --phase 03 --offline; then npm run gate -- --phase 03 --live --fixture roster.
Expected: offline suite exits 0; live suite records ten identities and ten bounded results, with concurrency appropriate to actual quota. If the ten-active stress test cannot run, report it as unverified.
Rollback: disable a failing adapter; retain sessions and artifacts; no fallback to an API key.

### Phase 4 - Shared context, memory, and reproducible handoffs
Depends on: G02; one live adapter for smoke checks.
Deliverable: focused, sourced context across independent runtimes.

- [ ] P04.1 Implement immutable context-packet schema and budget estimation.
- [ ] P04.2 Implement repository retrieval, ignore rules, secret exclusions, and source hashing.
- [ ] P04.3 Implement namespaced memory records with provenance, supersession, and project access checks.
- [ ] P04.4 Implement decision records and relevance/staleness checks after code changes.
- [ ] P04.5 Implement handoffs with requirements, artifacts, failed attempts, open questions, and exact revision.
- [ ] P04.6 Add context inspection in diagnostics, including why each item was included or omitted.
- [ ] P04.7 Add explicit import/export without mutating vendor session files.

Gate G04: recipient agents receive enough evidence to continue the synthetic task; stale or cross-project records are not silently promoted.
Check: npm run gate -- --phase 04 --offline; npm run gate -- --phase 04 --live --fixture handoff.
Expected: all required facts survive the packet, excluded sentinel secrets are absent, and the second runtime completes the handoff acceptance test.

### Phase 5 - Original XVANT tools and engineering skills
Depends on: G02 and G04.
Deliverable: a small complete toolkit with enforced execution rules.

- [ ] P05.1 Implement tool manifests, executor registry, effect classes, typed results, timeout and output limits.
- [ ] P05.2 Implement the twelve initial tools listed in Section 8.
- [ ] P05.3 Implement skill manifests, selective loading, dependency checks, hashes, and version pinning.
- [ ] P05.4 Author the ten original skills listed in Section 8 with inputs, steps, outputs, and meaningful fixtures.
- [ ] P05.5 Expose approved tools through an authenticated task-scoped MCP bridge.
- [ ] P05.6 Implement declarative lifecycle hooks with deduplication; executable hooks require registered code and permissions.
- [ ] P05.7 Add a compatibility report for each runtime/skill/tool combination, including bypass risks from native shell tools.
- [ ] P05.8 Add one local browser inspection workflow using a dedicated profile and screenshot/evidence artifacts.

Gate G05: no skill can grant permissions; stale patches fail; malicious retrieved instructions cannot modify policy; unsupported native-tool restrictions block the relevant profile.
Check: npm run gate -- --phase 05 --offline.
Expected: tool conformance and skill fixtures pass, including path traversal, junction escape, stale hashes, denied tool calls, and duplicate hooks.

### Phase 6 - Bounded hierarchy, routing, and parallel integration
Depends on: G03, G04, G05.
Deliverable: coordinated multi-runtime engineering.

- [ ] P06.1 Implement planner output validation against the task/DAG schema.
- [ ] P06.2 Implement explainable capability-first routing, explicit @alias assignment, and session continuity preference.
- [ ] P06.3 Implement dynamic leads and children with root budgets, depth limits, cancellation propagation, and slot release while waiting.
- [ ] P06.4 Implement scoped workspace creation, write ownership, dirty-work snapshots, and canonical path checks.
- [ ] P06.5 Implement the serialized integration queue and explicit conflict tasks.
- [ ] P06.6 Implement bounded repair/escalation and stop on repeated equivalent failures.
- [ ] P06.7 Implement quota-aware admission and fair scheduling so one root task cannot starve all others.
- [ ] P06.8 Register or restrict native subagent spawning; enforce limits for all known descendants.
- [ ] P06.9 Add a task using backend + frontend workers, independent review, and combined-revision verification.

Gate G06: no dependency deadlocks, no undisclosed descendant workers, no simultaneous integration writers, and no acceptance against stale evidence.
Check: npm run gate -- --phase 06 --offline; npm run gate -- --phase 06 --live --fixture parallel-feature.
Expected: property tests preserve caps for randomized task graphs; live work creates one coherent verified result.

### Phase 7 - Local application and daily workflow
Depends on: G02 through G06; UI work can start against the simulator after G02.
Deliverable: usable local browser application.

- [ ] P07.1 Implement project selection, runtime setup, and truthful capability/billing status.
- [ ] P07.2 Implement task composer with acceptance criteria and explicit execution policy.
- [ ] P07.3 Implement worker roster, @mentions, task graph, event timeline, and routing explanations.
- [ ] P07.4 Implement context/evidence inspector, patch viewer, checks, and accept/rework controls.
- [ ] P07.5 Implement pause/cancel/resume and single-action global stop with acknowledgement states.
- [ ] P07.6 Implement reconnect, stale-state conflict handling, pagination, and event backpressure recovery.
- [ ] P07.7 Implement keyboard navigation, focus management, labels, accessible status changes, and reduced-motion behavior.
- [ ] P07.8 Implement export, backup/restore UI, redacted diagnostics, and retention controls.

Gate G07: end-to-end task completes entirely in the UI; reload and navigation do not duplicate work; dangerous actions show the concrete affected scope.
Check: npm run gate -- --phase 07 --offline.
Expected: Playwright scenarios pass for empty state, slow connection, reconnect, double submit, expired approval, revision conflict, and keyboard-only review.

### Phase 8 - Native XVANT agent execution
Depends on: G05; completes before the full v1 claim of an independent runtime.
Deliverable: XVANT-owned model/tool loop using an explicitly configured local model.

- [ ] P08.1 Define a model-provider interface independent of external-agent adapters.
- [ ] P08.2 Implement a local endpoint adapter with capability probing, structured tool calls, and normalized usage uncertainty.
- [ ] P08.3 Implement the bounded loop: context -> model -> validate tool request -> policy -> execute -> receipt -> next step.
- [ ] P08.4 Implement cancellation, malformed-call handling, context limits, checkpoints, and bounded retries.
- [ ] P08.5 Run the same task/result contract as external workers; retain a distinct native-local identity.
- [ ] P08.6 Execute skill fixtures through the native loop using deterministic model stubs, then a real local model when hardware allows.

Gate G08: loop termination and permissions hold under adversarial model output. Live local-model capability is only claimed if tested; absent hardware leaves the live native feature experimental.
An external-runtime local-beta can ship without live G08. Full local-v1 requires live G08; lack of local-model hardware blocks that release claim rather than silently reducing the requirement.
Check: npm run gate -- --phase 08 --offline; npm run gate -- --phase 08 --live --fixture native-local.
Expected: no invalid tool executes, hard turn cap is respected, and all required receipts survive restart.

### Phase 9 - Evaluation and controlled improvement
Depends on: G06 and G07; native comparisons require G08.
Deliverable: reproducible evidence for routing and skill improvements.

- [ ] P09.1 Build the benchmark set and freeze hidden acceptance checks before running candidates.
- [ ] P09.2 Run single-Codex, single-Claude, single-OpenCode, and XVANT baselines on equivalent clean fixtures.
- [ ] P09.3 Record task success, human rework, elapsed time, token/usage observability, tool failures, conflicts, and recovery.
- [ ] P09.4 Generate candidate routing/skill changes from accepted evidence; isolate them from production defaults.
- [ ] P09.5 Evaluate candidates on held-out tasks and enforce promotion rules.
- [ ] P09.6 Implement rollback to the previous known-good skill/routing version.
- [ ] P09.7 Publish a local report including failures, sample size, model/runtime versions, and limitations.

Gate G09: claims are supported by paired results; task correctness cannot be traded away for a better composite score.
Check: npm run benchmark -- --suite v1 --repeats 3 --report docs/evidence/benchmark-v1.json.
Expected: complete machine-readable records for every scheduled attempt, explicit exclusions, and no concealed failures. Quota-limited runs remain incomplete rather than reported as successful.

### Phase 10 - Hardening and release
Depends on: all required gates; experimental capabilities remain visibly labeled.
Deliverable: reproducible install and release candidate.

- [ ] P10.1 Run runtime, correctness, security, and simplification reviews; fix blocking findings and rerun affected checks.
- [ ] P10.2 Run long-duration simulator and bounded live soak tests with fault injection.
- [ ] P10.3 Verify clean Windows installation, independent runtime discovery, backup/restore, and upgrade rollback.
- [ ] P10.4 Audit dependency licenses, lockfile integrity, secret handling, local API exposure, and executable hook boundaries.
- [ ] P10.5 Write install, recovery, quota, compatibility, and troubleshooting runbooks.
- [ ] P10.6 Package versioned artifacts with checksums and the tested support matrix.
- [ ] P10.7 Complete the release evidence checklist; no gate is satisfied by a skipped suite.

Gate G10: every required acceptance criterion has fresh evidence; no unresolved critical/high-impact correctness or security finding; remaining limitations are explicit.
Check: npm run release:check -- --profile local-v1.
Expected: exit 0 only with all required gate receipts and current artifact hashes. Publishing an installer or creating a remote release remains a separate authorized action.

## 11. Dependency order and milestones

```text
P00 -> P01 -> P02 -> P03 ------------------------+
                |                               |
                +-> P04 -> P05 -> P06 -> P07 ---+-> P09 -> P10
                |            |                  |
                |            +-> P08 -----------+
                +-> UI foundation (simulator)
```

Milestones:
- M1: G02, restart-safe offline controller.
- M2: G03 + G04, working cross-runtime handoff.
- M3: G05 + G06, original skills and coordinated parallel coding.
- M4: G07, daily-use local beta.
- M5: G08, native XVANT runtime with tested capability label.
- M6: G09 + G10, evaluated v1 release.

Planning estimate, not a delivery promise: roughly 8-14 focused engineering weeks for the external-runtime local beta and hardening, plus 2-4 weeks for native execution and evaluated learning. Provider compatibility, account access, Windows execution boundaries, and review findings can change this. Re-estimate after G00 and G03 using actual completed work. Do not compress recovery/security work to meet a speculative date.

## 12. Verification standards

Definition of ready for an implementation task:
- Concrete behavior, affected files, dependency gates, and expected evidence are identified.
- External API fields are checked against the pinned version.
- The required execution environment and data fixtures exist.
- Any billing or external side effect has a known policy.
- No unresolved architectural decision is hidden inside a coding task.

Definition of done for a code change:
1. Run the smallest meaningful behavior test; record a relevant failing case before the fix for substantial behavior changes.
2. Implement the change and run the targeted suite.
3. Run type checks, lint, and affected integration tests.
4. Observe the feature in its real runtime where feasible; a mock cannot prove adapter compatibility.
5. Review correctness, concurrency, security boundaries, and unnecessary complexity.
6. Fix important findings, rerun affected checks, and record exact commands/exit status/revision.
7. Commit a coherent change if implementation authorization includes Git work. Never claim tests passed from expected output.

Do not write implementation-mirroring tests or tests for harmless prose edits. Use tests to protect observable behavior and failure recovery.
Coverage targets: 90% branch coverage for state transitions, policy decisions, scheduler, and reconciliation; 80% for other core packages. No percentage substitutes for the mandatory failure scenarios.
Every suite must detect a nonzero expected count. A skipped live suite does not pass a live gate.
Do not auto-update snapshots to hide behavior changes.
Deterministic tests use injected clocks/randomness and no real model calls.
Live tests are explicitly selected and bounded; regular CI never consumes subscriptions.

Suggested repository commands:
| Command | Purpose | Successful evidence |
| --- | --- | --- |
| npm ci | Reproducible dependencies | Exit 0, lockfile unchanged |
| npm run typecheck | Strict TypeScript checks | Exit 0, no diagnostics |
| npm run lint | Static rules and dependency boundaries | Exit 0, no blocking violations |
| npm test | Offline behavior suite | Exit 0, expected tests discovered |
| npm run test:integration | SQLite, process, adapter-fixture boundaries | Exit 0, no leaked owned processes |
| npm run test:e2e | User flows | Exit 0, screenshots/traces on failure |
| npm run test:faults | Recovery and cancellation | Exit 0, all checkpoint injections covered |
| npm run build | Production bundle | Exit 0, manifest and checksums produced |
| npm run docs:check | Links, task IDs, gate references | Exit 0, no dangling references |
| npm run gate -- --phase NN --offline | Phase evidence | JSON report with revision and exact checks |

## 13. Mandatory failure and rescue map

| Failure | Detection | Behavior | Test |
| --- | --- | --- | --- |
| Invalid/empty objective | Request schema | Reject before model call | F01 |
| Cyclic or excessive graph | DAG validator | Return explicit offending edges/depth | F02 |
| Duplicate submit | Idempotency key + payload hash | Return same task or conflict | F03 |
| Worker exits before acknowledgement | Supervisor + operation ledger | Reconcile; unknown stays stopped | F04 |
| Worker completes after cancellation | Attempt generation/state | Preserve receipt; do not accept stale result | F05 |
| Stream disconnect | Heartbeat/cursor | Reconnect/reconcile, no prompt replay | F06 |
| Duplicate or reordered events | Native event ID and sequence policy | Deduplicate; recover state snapshot | F07 |
| Context too large | Budget estimate/capability | Split or block; preserve mandatory constraints | F08 |
| Missing credentials | Provider status | auth_required; official login flow | F09 |
| Quota exhausted | Provider error or verified quota status | Stop admission; show source/reset if known | F10 |
| Billing mode unknown | Missing reliable auth/usage signal | Unverified; no subscription-only claim | F11 |
| Dirty or changed checkout | Git status/revision hashes | Snapshot policy or pause integration | F12 |
| Conflicting patches | Integration application | Explicit conflict task; retain both patches | F13 |
| Path escape/reparse point | Canonical root + host checks | PATH_DENIED | F14 |
| Instruction injection in tool output | Typed data boundaries + policy | No authority elevation | F15 |
| Approval after patch/action changes | Action hash/revision/expiry | Reject stale approval | F16 |
| Disk full or SQLite busy/corrupt | Storage error classification | Stop new dispatch; preserve running receipts where possible | F17 |
| Controller crashes mid-migration | Transaction + backup | Recover prior consistent version | F18 |
| Parents occupy all slots | Scheduler wait-state accounting | Release waiting slots; schedule leaves | F19 |
| Infinite delegation/repair | Root counters + graph | Stop with specific exhausted budget | F20 |
| Browser reload/back/double-click | Idempotent API + state revision | Rehydrate; no duplicate action | F21 |
| Malicious localhost web request | Host/Origin/auth/CSRF checks | Deny mutation and stream access | F22 |
| Skill/hook modified mid-task | Pinned hashes | Continue pinned version or stop if missing | F23 |
| Missing test discovery | Expected suite manifest | Gate fails | F24 |
| Passing tests on old revision | Evidence revision mismatch | STALE_EVIDENCE | F25 |
| Attached session has another controller | Ownership/lease checks | Read-only or conflict; no competing writes | F26 |
| Unreported native subagents | Adapter capability/policy | Disable spawning or block guaranteed-bound mode | F27 |
| Worker process tree survives stop | Owned-process scan | Escalate termination; report needs_attention | F28 |
| Cross-project memory request | Namespace authorization | Deny and audit | F29 |
| Malformed native-model tool call | Runtime schema | No execution; bounded repair | F30 |
| Slow event consumer | Queue limits + replay cursor | Coalesce text; preserve durable transitions | F31 |
| Backup missing artifact | Hash manifest validation | Restore fails safely without replacing current state | F32 |

Typed error codes: INVALID_INPUT, CONFLICT, CAPABILITY_UNSUPPORTED, VERSION_UNSUPPORTED, AUTH_REQUIRED, QUOTA_BLOCKED, BILLING_UNVERIFIED, PATH_DENIED, POLICY_DENIED, STALE_APPROVAL, STALE_EVIDENCE, CONTEXT_EXCEEDED, STORAGE_UNAVAILABLE, OPERATION_UNKNOWN, WORKER_UNAVAILABLE, BUDGET_EXHAUSTED.
Unexpected exceptions use INTERNAL_ERROR plus a correlation ID and redacted diagnostics; never silently convert to success.

## 14. Evaluation and performance targets

Initial benchmark: 24 synthetic/local tasks, six each for debugging, feature work, cross-module change, and test/review work. Include at least four tasks where a single worker is expected to be sufficient and four where parallelization is useful.
Run each selected baseline/candidate three times with fixed repository revisions and equivalent task limits. Use separate training/tuning and held-out sets. Keep acceptance tests unavailable to the worker when feasible; do not alter them to make an attempt pass.
With four configurations, 24 tasks, and three repetitions, the full external-runtime campaign contains 288 attempts. Schedule it in resumable batches within subscription limits; a small smoke sample is an earlier checkpoint, not a substitute for the complete campaign.

Primary metric: fraction of tasks meeting all acceptance criteria with no blocking review finding.
Secondary: human rework, wall-clock duration, observed usage, conflicts, unnecessary delegation, failed tool actions, recovery success.
Report missing usage telemetry explicitly. Do not convert unknown subscription usage to fabricated dollar cost.

Candidate promotion:
- Zero regressions in mandatory safety/recovery fixtures.
- No decrease in accepted task count on the fixed held-out sample.
- At least one declared benefit (quality, latency, or measured usage) with all trade-offs shown.
- Small samples are directional evidence, not proof of general superiority.
- Preserve the prior version and reproduce the result before changing defaults.

Initial local service targets, measured with a simulated adapter on a recorded machine:
- UI command acknowledgement p95 below 250 ms, excluding model/tool execution.
- Persisted event visible in UI p95 below 500 ms on loopback.
- Global stop prevents new dispatch within 1 second; active interruption acknowledgement depends on adapter and is separately reported.
- Ten connected simulated workers, 100 queued tasks, and 100,000 stored events remain usable.
- An 8-hour simulator soak has no task loss, leaked owned process, or unbounded queue growth.
- A bounded live smoke uses all enabled runtime kinds; rate limits are outcomes, not reasons to retry indefinitely.

## 15. Self-review and resolved design issues

Review posture: hold the agreed scope and strengthen correctness; no autonomous scope expansion.
This is a design review, not an independent code review and not evidence of a working product.

| Concern found | Resolution incorporated | Gate |
| --- | --- | --- |
| Original product accidentally becomes a Hermes wrapper | No Hermes/ECC runtime dependencies; native loop included | G05/G08 |
| Subscription authentication confused with universal model access | Separate backend classes and provider compatibility gate | G00/G03 |
| All ten workers assumed to mean ten allowances | Account-scoped quota groups; connected vs active settings | G03/G06 |
| Resume confused with live attach | Explicit managed/attached/imported modes | G03 |
| Blind retry duplicates shell or external actions | Durable ledger and unknown-outcome reconciliation | G02 |
| Hierarchy can deadlock or multiply hidden agents | Waiting-slot release, global descendant limits, capability gates | G06 |
| Worktrees incorrectly treated as a security sandbox | Separate execution-host enforcement | G02/G05 |
| Every agent gets all tools and memory | Scoped tool catalogs and focused provenance packets | G04/G05 |
| Successful worker response accepted without proof | Revision-bound test/review gates | G06 |
| Local HTTP assumed safe by default | Auth, CSRF, Origin/Host, untrusted rendering tests | G02/G07 |
| Skill learning silently changes policy | Candidate evaluation and pinned skill versions | G05/G09 |
| Current Node executable belongs to Hermes installation | Independent runtime path validation | G00/G10 |
| Native Windows runtime limitations hidden | Tested support matrix and explicit host selection | G00/G10 |
| Self-improvement rewrites running controller | Core improvements are isolated patches with normal release gates | G09/G10 |

Remaining uncertainties have owners and exit conditions:
- Provider/account eligibility: adapter implementer; resolve with source review and bounded live probe before marking support.
- Reliable quota telemetry: adapter implementer; if absent, use provider-limit errors and label usage unknown.
- Native Windows sandbox capability: execution-host implementer; pass escape/cancellation tests or restrict the capability.
- Live attachment to existing arbitrary terminals: not promised; only expose verified transports.
- Local-model hardware suitability: native runtime implementer; offline loop can pass before live model qualification.
- Comparative quality improvement: evaluator; cannot be resolved without benchmark results.

## 16. Explicit deferred backlog

These are outside the first local release, not forgotten requirements:
- D01: Native desktop shell and installer auto-update; after browser workflow stabilizes.
- D02: Remote multi-host workers, SSH agents, and distributed database; after local recovery is proven.
- D03: Multi-user teams, RBAC, shared billing, and hosted service; requires a separate account/security design.
- D04: Paid API backends and paid external tools; require explicit configuration and spending authorization.
- D05: Embedding/vector search; only after measured retrieval failures justify it.
- D06: Third-party plugin marketplace; requires distribution, signing, permissions, and revocation design.
- D07: Full live attachment to arbitrary GUI/terminal sessions; expose only tested provider mechanisms.
- D08: Unattended external writes, deployment, and publishing; separate capabilities and approval scopes.
- D09: Writable non-Git projects; implement snapshot/rollback before enabling.
- D10: Automatic promotion of learned skills; initially user-visible evaluation and reversible promotion.
- D11: Direct reuse/import of ECC/Hermes skill packs; optional compatibility work, not a runtime dependency.
- D12: Unattended core self-modification; never mutate the running controller outside the normal update process.

## 17. Source evidence and verification boundaries

Official or first-party sources consulted on 2026-09-26:
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): supported integration surface and thread/turn events; pin schemas to the tested runtime.
- [Codex authentication](https://learn.chatgpt.com/docs/auth): ChatGPT sign-in and API-key access are distinct.
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and [sessions](https://code.claude.com/docs/en/agent-sdk/sessions): coding runtime integration and explicit session continuity.
- [Claude subscription SDK notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): the page's update says the announced billing change is paused.
- [Claude credential guidance](https://code.claude.com/docs/en/legal-and-compliance): developer and credential restrictions remain relevant. Do not treat the billing notice as blanket authorization for a distributed product.
- [OpenCode server](https://opencode.ai/docs/server/) and [providers](https://opencode.ai/docs/providers/): server/session integration and documented provider sign-in choices.
- [ECC](https://github.com/affaan-m/ECC) and [Hermes tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/): design references only; XVANT owns its implementation.

Historical baseline observed during planning (superseded by the Phase 1 compatibility record where noted):
- C:\Users\jiang\XVANT did not exist before this plan.
- node and npm resolve under C:\Users\jiang\AppData\Local\hermes\node. The observed Node version is v22.23.2; the proposed independent Node 24 baseline still requires G00 qualification.
- git, codex, and claude are discoverable on PATH.
- opencode was not discoverable through Get-Command; this does not prove it is absent elsewhere.
- No login, quota, live agent, provider runtime version, model capability, or sandbox behavior was tested.
- The ordinary shell sandbox could not start; read-only inspection ran through approved escalation.
- The xvant-plan and xvant-plan-review skills were read. The diagram reference was found under .agents/skills/_shared. The referenced expanded engineering-review procedure was unavailable; the review above follows the main skill's explicit failure-map and evidence rules.

## Planning artifact verification
The saved bundle was checked for phase/gate coverage, 82 unique task IDs, 16 requirements, 32 named failure scenarios, balanced code fences, and stale project names/placeholders. The embedded first-slice examples were transformed with Node's TypeScript support and exercised using a small assertion harness: all 15 intended red-stage cases failed, and all 15 green-stage cases passed. This was not a Vitest installation, TypeScript typecheck, provider test, or application execution.
Reproduce the document/snippet audit with node docs/plans/audit-plan.mjs. The audit script and 2026-09-26-xvant-plan-audit.json are historical planning artifacts. G01 has separate implementation evidence at ../evidence/G01.json; G00 and G02-G10 remain open.

## 18. Execution handoff

Resume from [the root plan](../../plan.md), [Phase 2 record](../phase-02-progress.md), and the latest file in `../../.Codex/handoffs/`. Repository: `C:\Users\jiang\XVANT`; branch `work/phase-2`; Phase 1 baseline commit `b91673f`. Inspect changes and rerun G02 first. The receipt records its Git base revision and full source-content manifest, including uncommitted files.

Next: Linux qualification and Phase 3 offline adapter contracts/probes. No live provider/auth or billing claims are qualified by simulation. Confirm account/auth scope before any live provider operation; do not enable paid fallback.
