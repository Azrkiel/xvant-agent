# Offline provider foundation

Phase 3 currently provides in-memory contracts and synthetic fixtures for Codex,
Claude, and OpenCode. It does not start live workers, attach to sessions, submit
prompts, approve tools, read credentials, or enable paid fallback. The durable
controller still executes only the Phase 2 simulator.

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
Codex `0.158.0-alpha.2.1`. Thirteen schema roots were exported by the installed CLI,
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
is no reconnect or resend. Hook failure prevents sending. Response persistence
and durable recovery are still the caller's responsibility.

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
They fsync a temporary intent journal before each write, verify failure outcomes,
stop the owned peer, and remove their temporary files. An exit code of zero for a
failure scenario means its expected unknown outcome was observed.

This is an offline protocol slice, not a live Codex adapter. Thread creation/resume,
full notification support, permission grants, native error classification, owned
provider launch, authentication, billing, artifact attestation and durable Store
integration remain unqualified. The Phase 2 controller continues using simulator
evidence only. Claude and OpenCode still use the earlier synthetic subsets.
