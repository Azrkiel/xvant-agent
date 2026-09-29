# Offline provider foundation

Phase 3 currently provides contracts, a durable provider journal and owned offline
controllers for Codex, Claude, and OpenCode. Those controllers launch only fixed
synthetic peers. Nothing here starts a live worker, attaches to a real session,
submits a prompt to a model, approves tools, reads credentials, or enables paid
fallback. The sections below were added in order; later sections supersede the
"remaining work" notes of earlier ones.

## Claude and OpenCode stream profiles

`src/providers/native-profiles.ts` and `native-stream.ts` add version-pinned,
host-driven offline stream readers. Claude uses SDK `0.3.283`; OpenCode uses SDK
`1.18.33` v2 event declarations. `native-pins.json` records package integrity,
declaration-file SHA-256 and selected property/required-field inventories from the
published [Claude SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk/v/0.3.283)
and [OpenCode SDK](https://www.npmjs.com/package/@opencode-ai/sdk/v/1.18.33).

These are supported protocol projections, not complete SDK schemas. Result,
correlation and permission fields are checked. Nested usage, arbitrary tool input,
permission metadata and vendor error details remain opaque and confer no authority.
Unknown control requests and unsupported event envelopes fail closed. Claude UUID
fields are treated as bounded opaque IDs. Installed CLI/auth/subscription
compatibility is not established by an SDK package pin.

Reproduce pins without installing or executing either SDK:

```sh
npm pack @anthropic-ai/claude-agent-sdk@0.3.283 --ignore-scripts --pack-destination .artifacts
npm pack @opencode-ai/sdk@1.18.33 --ignore-scripts --pack-destination .artifacts
node scripts/pin-provider-types.mjs .artifacts
```

The pin script verifies each archive's fixed SHA-512 before reading declarations
directly from it. It uses the repository's TypeScript parser and the host's `tar`;
downloaded JavaScript is never imported. Dependencies and lockfiles stay unchanged.

Claude NDJSON results must match the session and echoed host request ID. Queued,
resumed, multi-request or deferred continuations are rejected. OpenCode SSE results
must match both session IDs and the assistant's parent user-message ID. Idle alone
and tool-call boundaries cannot establish completion. Vendor message IDs remain
distinct from the host request ID. Failed results cannot become completed results.

Readers bound the stream to 1 MiB, frames to 64 KiB, messages to 4,096 and permission
requests to 64. SSE supports LF/CRLF framing, comments, multiline data and fragmented
UTF-8; no reconnect or replay occurs. CR-only framing is unsupported. Permission
actions contain denial only. The host must confirm every denial was written before
`end()` can expose the result; malformed input, partial EOF, mismatches, cancellation
and duplicate terminal messages invalidate the stream. Clean EOF is necessary but
the host must also confirm owned process shutdown before verification.

`scripts/native-fixture.mjs` launches only a fixed synthetic peer through the process
supervisor. Eight scenarios per provider cover success, denial, wrong session,
malformed/partial output, error, timeout and cancellation. OpenCode SSE travels over
fixture pipes here; its permission action is an HTTP request descriptor, not a real
HTTP call. G03 includes both process suites and direct denial runtime checks.

These readers do not launch a provider, access credentials, accept tasks or enable
paid fallback. Journal integration, session setup, interruption and artifact
verification were added offline in later sections.

Run with the repository's pinned Node version:

```sh
npm run probe -- --offline --runtime all
npm run probe -- --inventory-only --runtime all
npm run gate -- --phase 03 --offline
```

Select `codex`, `claude`, or `opencode` instead of `all` to inspect one provider.
Offline mode requires no installed providers or credentials. Inventory executes
only a fixed `--version` argument with a five-second timeout, a 16 KiB output
limit, and no shell. Windows inventory recognizes native `.exe` installations;
script-only installations are reported unavailable. Inventory exits 0 when all
requested versions were read, 2 for unavailable executables, and 1 for failures.
It prints parsed version numbers rather than raw diagnostics. Version discovery
does not establish protocol compatibility, authentication, or billing.

Live flags, including `--live --read-only`, are rejected with exit 2 before a
provider is invoked. G03 offline evidence is explicitly scoped to this foundation;
it cannot satisfy the plan's live G03 milestone.

## Contracts

`ProviderRegistry` tests routing independently of vendor transports. Its IDs are
stable, aliases are unique ignoring case, and native session/run IDs are opaque.
Native sessions are unique per runtime and host even when endpoint labels differ.
Registrations, returned views, and active bindings are copied.

Only managed fixtures can begin turns. Imported and attached sessions remain
noncontrollable. A session retains its reservation after cancellation requests,
disconnection, errors, and terminal output. Only a trusted controller's explicit
reconciliation releases it. That caller must confirm execution stopped and finish
verification first. This in-memory registry is not a durable lease or an OS sandbox.

Events must match worker, task, attempt, generation, native session, and native run.
Sequences are contiguous and bounded to 4,096 events per attempt, with at most
16,384 characters per output. Identical normalized events deduplicate; changed
duplicates, gaps, stale generations, additional receipts, and post-terminal events
are rejected. These are XVANT envelope sequences, not claimed vendor event IDs.
No event can approve a task. Caller-owned transport code must stop/reconcile after
a rejected stream; it must not resubmit the prompt automatically.

`negotiate` is a pure advisory comparison against trusted host qualification data,
bound to the runtime, version, adapter, host, endpoint, and quota group. Offline
evidence, unknown auth/billing, and missing required capabilities cannot qualify.
No live transport consumes this result. Before live integration, persist dated,
source-bound probe evidence and enforce its authenticity and freshness in the host;
never accept a qualification object from a worker or HTTP client.

Usage totals keep measured and estimated tokens separate and retain the count of
unknown samples per account group. They are not billing totals or admission limits.
Normalized failure contracts distinguish auth, quota, model availability, version,
worker failure, and uncertainty. Native error translation and account-scoped quota
admission remain work for the live integrations.

## Fixture provenance and limits

The fixtures are small synthetic result subsets informed by official sources read
on 2026-09-27. They are not captured live transcripts or full pinned SDK schemas:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): thread/turn result
  correlation and completed/interrupted/failed outcomes.
- [Claude headless output](https://code.claude.com/docs/en/headless): result messages
  and session correlation. The fixture's `invocationId` is host-owned metadata,
  not a native Claude run ID. The full SDK type reference could not be fetched;
  exact versioned schema validation remains unqualified.
- [OpenCode server](https://opencode.ai/docs/server/) and its linked
  [SDK types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts):
  assistant message/session correlation. The fixture requires a completed assistant
  message with `finish: stop`; session idle alone never proves a successful result.
  OpenCode message IDs are not represented as a provider-issued turn ID.

No permission-granting handler is exposed. Live work still requires provider-owned transport
isolation, authenticated endpoint identity, pinned schemas, bounded streaming,
permission callbacks, cancellation/recovery evidence, and account/auth approval.
Linux qualification and hostile-code containment remain open.

## Codex offline transport slice

`src/codex` adds a bounded JSON-line RPC channel and a one-attempt lifecycle for
Codex `0.158.0-alpha.2.1`. Nineteen schema roots were exported by the installed CLI,
with per-file SHA-256 provenance and shared definitions in `schema.json`. The pin
preserves generated schema fields, including metadata and defaults. Runtime
validation uses the already-pinned Zod JSON Schema converter; no dependency was added.

Reproduce the pin without starting an app-server session:

```sh
codex app-server generate-json-schema --out .artifacts/codex-schema
node scripts/pin-codex-schema.mjs .artifacts/codex-schema 0.158.0-alpha.2.1
```

First verify the CLI version matches. Regenerating from another version requires
reviewing the profile and tests, not changing the version argument alone.

The channel limits frame bytes, chunk bytes, frames per chunk, pending requests,
and response deadlines. It persists an exact outgoing frame through a required
host `beforeWrite` hook before invoking the supplied writer. Write failure,
timeout, malformed input, unexpected response IDs, or disconnection closes the
channel. Attempted, unacknowledged request IDs remain visible as uncertain; there
is no reconnect or resend. Hook failure prevents sending. The optional synchronous
`beforeReceive` barrier commits before replies resolve or notifications reach a
handler; failure closes the channel without delivering the message.

The lifecycle validates initialization and the selected turn messages, fixes the
thread ID, tracks the native turn, sets a read-only policy, and denies command/file
approval requests. Unknown server requests fail closed; other notifications are
ignored and cannot change authority or state. Interruption is a request, not proof
of shutdown. Late completion cannot clear uncertainty. Successful output remains
`result_pending`, never accepted. One lifecycle object represents one attempt;
creating another is not authorization to retry an uncertain operation.

```sh
node scripts/codex-fixture.mjs success
node scripts/codex-fixture.mjs approval
node scripts/codex-fixture.mjs interrupt
node scripts/codex-fixture.mjs disconnect
node scripts/codex-fixture.mjs malformed
node scripts/codex-fixture.mjs timeout
```

These commands launch only the checked-in synthetic Node peer through real pipes.
They use a temporary SQLite Store with WAL and FULL synchronous commits, verify
failure outcomes, stop the owned peer, and remove their temporary files. An exit code of zero for a
failure scenario means its expected unknown outcome was observed.

This is an offline protocol slice, not a live Codex adapter. Thread creation/resume,
full notification support, permission grants, native error classification, owned
provider launch, authentication, billing and artifact attestation remain
unqualified. The Phase 2 controller continues using simulator
evidence only. Claude and OpenCode still use the earlier synthetic subsets.

## Durable offline provider journal

`Store.providers` reserves a connection against the task's current row version,
work revision, attempt, worker, workspace, native session and controller generation.
Only managed offline records are admitted. Workspace and worker reservations
conflict with simulated dispatch too; changing an endpoint alias cannot bypass
native session ownership. Connection and attempt identities cannot be reused.

`durableCodexChannel` commits the exact outbound frame before writing, checks the
controller fence again immediately before the writer, and commits inbound routing
metadata and a SHA-256 digest before delivering a reply or notification. Incoming
text and error bodies are not retained. Outbound frames include prompt text, so
the database and backups must be treated as private project data. The ledger is
bounded to 4,096 entries per connection and 64 KiB per frame. It is an audit journal,
not a message replay queue; response bodies cannot be reconstructed from digests.

Lease takeover fences old callbacks. On restart, open connections become unknown,
tasks require attention, and reservations remain held. A validated native terminal
result also requires attention and retains reservations. Only trusted host
reconciliation releases them; no HTTP or provider message exposes that authority.
Native results never acquire simulated hashes, receipts or acceptance authority.

Schema v2 migrates existing v1 databases transactionally. Verified snapshots support
both versions, including the provider records and reservation constraints. Eight
real-process crash tests cover reservation/intent commits, pipe writes, reply
persistence and terminal results. These tests and the six synthetic Codex process
scenarios qualify offline durability only. Native artifact attestation and host
verification are implemented as a separate host-only offline stage below.

## Native artifact verification

`NativeVerifier` accepts host-registered workspace paths and check commands. A
completed native outcome and host-confirmed provider shutdown are prerequisites.
It captures the actual workspace into immutable content-addressed objects, runs
each required check through the existing bounded process supervisor, and captures
the workspace again after every check. Changed contents, unsafe paths, excessive
output, failed shutdown or a lost controller lease cannot produce passing evidence.

Snapshots include regular files, executable bits and empty directories, excluding
only root `.git` metadata. Links and special files are rejected. Limits are 1,024
entries, 16 MiB total file bytes and depth 32; larger workspaces fail closed. Store
the database and artifact directory outside the captured workspace. Checks must
leave the captured tree unchanged. This detects ordinary local changes; it is not
an atomic filesystem snapshot or protection against hostile concurrent processes.

Native receipts bind the task, attempt, work revision, connection, controller
generation, workspace/root hash, host, provider, session/run, tree/artifact hashes
and registered command hash. They explicitly say `offline` and never use simulated
evidence labels. Check stdout/stderr is not retained. Artifact references and the
verification report commit together; snapshots preserve both. Interrupted
verification recovers as unknown, retaining reservations.

Successful verification records `verified`; failed checks record
`verification_failed`. Both keep the task at `needs_attention` until a separate
host action. Native receipts remain separate from the simulator's acceptance
contract. No HTTP acceptance route or live qualification is added by this stage.

## Explicit offline native acceptance

`NativeReviewController` prepares a review only from passed host verification of a
completed native run. It exposes the exact evidence and the immutable artifact set
for inspection, rechecking every referenced object's hash and manifest membership.
Preparation moves the task to `ready_for_acceptance` and retains reservations.

Acceptance requires an explicit actor ID, current task row version, the reviewed
evidence digest and `classification: offline`. It checks the stored receipt bindings,
required checks, native connection state and artifact integrity again. The decision,
audit event, task state and reservation release commit in one idempotent transaction.
Restarted controllers can complete a pending review without rerunning the provider;
crashes cannot leave a partial acceptance or duplicate its audit event.

The accepted object is the immutable reviewed artifact set, not the current mutable
workspace. Task `nativeQualification` preserves the native runtime, connection and
offline scope. Simulator acceptance cannot consume these tasks or receipts. Failed,
cancelled, unknown or reconciled connections cannot enter this acceptance path.
The controller API is host-only: actor identity/authorization must come from the
host, never a provider message. No public HTTP route, live account authorization or
paid fallback is enabled. Production Codex process ownership remains unqualified.

## Owned offline lifecycle through review

`OfflineCodexController` launches only the fixed synthetic Codex peer through
`WorkerSupervisor`. It reserves the offline connection, journals protocol traffic,
declines permission requests, correlates the native turn, and waits for the owned
process to close successfully. Complete EOF and no pending RPC writes/replies are
required before recording a terminal outcome. Partial or malformed trailing output,
disconnects, timeout and controller stop retain reservations without verification
or automatic resend.

After successful shutdown, the host verifier checks the registered workspace and
commands, then prepares immutable evidence for explicit review. Provider completion
cannot accept the task. Seven actual-process crash cases cover reservation, session
binding, confirmed shutdown, terminal commit, verification and review preparation; recovery never
replays the turn. Interactive stdin and stdout remain bounded by the supervisor.

This qualifies the Windows offline orchestration path only. It does not launch a
live provider, authenticate an account, or provide hostile-process containment.
Live lifecycle integration and broader provider protocol coverage remain open.

## Explicit offline thread setup and errors

The owned controller defaults to one explicit `thread/resume` handshake; its third
`run` argument can select `create` for `thread/start`. Both run against the fixed
synthetic peer. A created session starts with a connection-specific provisional
reservation. The host validates the reply, then binds the returned session ID and
its native reservation in one fenced transaction before sending `turn/start`.
Binding cannot steal another reservation, happen twice, or follow a turn dispatch.

Replies must match the requested workspace, pinned CLI version, read-only sandbox,
user-reviewed untrusted approval policy and idle thread state. Resume also checks
the requested thread ID and excludes historical turns. Thread-start notifications
are correlated even when they precede the reply or arrive after turn dispatch.
The older transport-only lifecycle fixtures still support a host-supplied loaded
thread; the owned controller always performs explicit setup.

Thread RPC errors, malformed/mismatched replies, timeout and disconnect prevent
turn dispatch. Correlated native `error` notifications stop the peer even when
`willRetry` is true; XVANT neither retries nor treats the notification as successful
completion. Failed turns never enter verification. Error bodies remain transient;
the existing journal retains bounded envelope metadata and digests.

Crashes before and after session binding preserve the provisional or final native
reservation respectively. Recovery requires attention and never repeats thread
creation, resume or turn dispatch. These are offline protocol tests, not live
thread creation/resume qualification or imported-history support.

## Durable offline Claude/OpenCode orchestration

`OfflineNativeController` connects the pinned stream projections to the provider
journal, owned subprocess supervisor, artifact verifier and explicit review path.
It launches only `tests/fixtures/native-peer.mjs`. Each parsed envelope is persisted
synchronously before interpretation; journal failures prevent denial delivery and
result handling. Outbound fixture start and denial bytes are persisted before the
owned write, with fresh ownership checks. Incoming bodies remain transient; the
journal retains their bounded metadata and digest.

The host attempt ID correlates Claude `user_message_uuid` or OpenCode `parentID`;
the reserved session must also match. After all denials have been written, complete
EOF and successful owned shutdown are required before recording completion. The
shared evidence field `nativeRunId` holds the terminal Claude result UUID or
OpenCode assistant message ID in this projection. These are message identities,
not vendor turn IDs; `attemptId` separately binds the host invocation. Journal
outbound numeric IDs identify host sends, not vendor JSON-RPC requests.

Passed artifact verification prepares `ready_for_acceptance`, never acceptance.
Errors, incomplete output, timeout, cancellation, persistence failure and fencing
keep reservations and never trigger replay. Fourteen actual-process crash cases
cover both providers from reservation through review preparation. G03 also runs
both durable permission-denial scenarios through artifact verification and review.

This remains Windows offline fixture evidence. OpenCode HTTP replies are descriptors
sent over fixture pipes; there is no HTTP endpoint or live SDK launcher. Session
setup, native interruption, broader event schemas, authenticated endpoint ownership,
live account admission and Linux qualification remain open.

## Existing-session setup and offline native interruption

The owned Claude/OpenCode controller now requires setup before sending its fixture
invocation. Claude uses a correlated `initialize` control request and requires a
well-formed success response with empty inherited permission/dialog lists. Its
first turn metadata must match the reserved session, workspace, fixture CLI version
2.1.283 and plan mode with no tools, MCP servers or plugins. This CLI fixture pin is
separate from the SDK declaration version. Missing or contradictory setup fails
closed. It does not authenticate or create a live Claude session.

OpenCode uses a `GET /session/{sessionID}` descriptor and validates the returned
session ID, directory and unarchived timestamps. HTTP responses are explicitly
marked fixture envelopes inside the test pipe; they are not native SSE events.
No HTTP listener, client, reconnect or live session creation is supplied.

An admitted interrupt journals Claude `interrupt` with `cancel_queued: true`,
requiring advertised receipt and queue-cancellation capabilities. Its correlated
receipt must report no queued survivors and no unrelated cancelled requests.
OpenCode uses a correlated `POST /session/{sessionID}/abort` descriptor with a true
success response. For both, acknowledgement alone is insufficient: terminal output,
complete EOF, finished writes and successful owned shutdown must also occur.
Terminal output may precede the acknowledgement. Only then does the host record
`cancelled`, retain reservations and skip verification/acceptance. Missing, failed,
mismatched or partial replies remain unknown without replay.

This qualifies the fixed-peer interruption scenario, not a public live interrupt
API. `stop()` remains the emergency owned-process cancellation path. Eighteen
actual-process crash cases now include setup and interrupt boundaries. G03 runs
direct setup-to-review and interruption scenarios for each provider. Native session
creation/resume launch, live transport/auth ownership and broader events remain open.

## Offline OpenCode session creation

The owned controller accepts `run(dispatch, scenario, 'create')` for OpenCode.
Default `resume` keeps the existing lookup path. Creation first reserves a
connection-specific provisional native identity (`pending:<connectionId>`), then
journals a `POST /session` descriptor with a registered directory and a single
deny-all permission rule. No prompt is dispatched yet.

The reply must contain a valid, unarchived session in that directory, no parent or
revert state, and exactly the requested deny-all permissions. The returned ID must
not use the provisional namespace. In one fenced transaction, the journal swaps
the provisional reservation for the returned session, records the binding, and
rejects collisions with existing provider or simulator reservations. Binding is
allowed once, after the matching provider creation intent and before invocation.
Only after that commit does the stream adopt the new ID and permit dispatch.

Completion evidence and interrupt paths use the returned session. Invalid replies,
collisions, storage errors and crashes never recreate or replay work. Four new
actual-process crash cases prove recovery retains the provisional or bound identity
on the appropriate side of the transaction. G03 runs created-session denial and
interruption scenarios directly. This is still a fixed-peer HTTP descriptor
fixture; no remote session is created or deleted.

Claude creation uses a separate launch-options path, described below. Live transports,
account admission, endpoint authentication and Linux qualification remain open.

## Offline Claude creation and resume launch options

The controller models the pinned SDK's two distinct launch choices. `create` requires
a host-selected UUID in the worker's nativeSessionId and produces `sessionId` options.
Default `resume` produces an explicit `resume` option for that exact session, never
an implicit latest-session request. Both use the registered absolute directory and
plan mode, with empty tools, MCP servers, plugins and setting sources. Mixed IDs,
continue/fork options, extra fields and broader permissions fail validation before
reservation. The selected Options fields are pinned to the SDK declaration archive.

Unlike OpenCode creation, Claude's final identity is known before launch. The host
reserves it directly, rejecting collisions before creating a connection or intent.
It then commits a `fixture/claude-launch` descriptor to the journal and rechecks its
ownership immediately before starting the fixed peer. This descriptor records host
launch configuration, not a native protocol message. The peer validates the same
options; initialization and first-turn metadata must still match the reserved ID
and directory. No provisional reservation swap or invented create RPC is involved.

Storage failure, stop or lease takeover before startup prevents the launch. Eight
actual-process crash cases cover create/resume on both sides of intent persistence
and startup; recovery keeps the exact session reservation and never relaunches.
G03 now exercises created-session review and interruption for both providers.

Only the synthetic peer is launched. No Claude SDK is loaded, session history is
read, authentication is inspected or provider session is created. Live launch,
endpoint ownership, billing admission, public interrupt API and Linux qualification
remain open.

## Explicit offline native interrupt admission

Interruption is a host call, not a scenario side effect. `interrupt(connectionId,
actorId)` on `OfflineNativeController` admits one interrupt for a turn that this
controller instance currently owns. Admission requires a dispatched, still-running
turn: setup, pending dispatch, a received terminal result, a failed stream or an
unknown connection return `NOT_INTERRUPTIBLE`. Claude additionally needs its init
metadata; if init lacks the receipt and queue-cancellation capabilities, admission
returns `CAPABILITY_UNSUPPORTED`. Other controllers' or finished connections return
`NOT_FOUND`; a stopped controller returns `CONTROLLER_STOPPED`.

`ProviderJournal.requestInterrupt` commits the actor, controller generation and a
`provider.interrupt_requested` audit event in one fenced transaction. It rechecks
that a start frame was journaled and no terminal run is bound. Only after that
commit is the interrupt frame queued behind earlier sends, journaled and written.
A failed commit sends nothing and can be retried; a repeated call returns
`already_requested` without a second frame. Once admitted, the journal refuses a
`completed` outcome, so an interrupted turn can never enter verification.

Confirmation rules are unchanged: acknowledgement, terminal output, complete EOF,
finished writes and owned shutdown yield `cancelled`; anything missing stays
unknown. A holding peer that is never interrupted times out as unknown. Four new
actual-process crash cases cover death inside and after admission; recovery keeps
the admission record, never sends the interrupt or the turn again and retains
reservations. G03 fixtures now poll admission like a host operator would.

`OfflineCodexController.interrupt` follows the same admission contract. Codex
binds its native turn ID at dispatch, so the journal requires a bound turn for
Codex and an unbound terminal identity for Claude/OpenCode. Admission requires
lifecycle state `running`; the `turn/interrupt` request goes through the durable
channel. `cancelled` needs a valid reply, an `interrupted` terminal turn, EOF and
owned shutdown. An RPC error, or a turn that reports `completed` after admission,
stays unknown. Two further crash cases cover Codex death inside and after
admission.

The actor ID is host-supplied and not authenticated here; no HTTP route exposes
interruption. Live interrupt APIs, endpoint authentication and Linux qualification
remain open.

## Native failure normalization and account admission blocks

`src/providers/failures.ts` maps pinned vendor error codes onto the contract's
failure codes. It never reads message text. Codex uses `CodexErrorInfo` from the
pinned app-server schema. Claude uses `SDKAssistantMessageError`, falling back to
the result subtype or stop reason. OpenCode uses the `AssistantMessage.error`
union names and `APIError` status codes. `native-pins.json` now also records
these literal unions from the same integrity-checked SDK archives.

| Signal                                                                                        | Code                | Scope         |
| --------------------------------------------------------------------------------------------- | ------------------- | ------------- |
| Codex `unauthorized`; Claude auth/account codes; OpenCode `ProviderAuthError`; HTTP 401/403   | `AUTH_REQUIRED`     | account group |
| Codex `usageLimitExceeded`/`rateLimitExceeded`; Claude `rate_limit`/`billing_error`; HTTP 429 | `QUOTA_BLOCKED`     | account group |
| Claude `model_not_found`                                                                      | `MODEL_UNAVAILABLE` | attempt       |
| Everything else, including unpinned codes (`unrecognized`)                                    | `WORKER_FAILED`     | attempt       |

The controllers record the first classified failure through
`ProviderJournal.recordFailure` before the terminal outcome or uncertainty is
committed. That applies to failed results, Codex `error` notifications and
OpenCode `session.error`, but not to an abort after an admitted interrupt. The
journal keeps only the code, scope and a bounded native label, plus audit events.

An uncleared account-group failure makes `reserve()` fail with that code for any
worker in the same `quotaGroupId`, across runtimes and restarts. Admission
therefore stops instead of retrying or rotating accounts. Only the host-only
`clearBlock(quotaGroupId, actorId)` lifts it, after the account is repaired; no
provider message or HTTP route can do so. Reconciling the failed attempt does not
clear the block. Crash cases show that a failure committed before the terminal
result survives restart, and that a crash inside the failure transaction leaves
no partial block. These classifications come from synthetic fixtures; real
provider error traffic has not been observed.
