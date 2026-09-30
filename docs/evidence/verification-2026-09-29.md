# XVANT verification — 2026-09-29

## Verdict

The Windows offline foundation passes. OpenCode 2.0.19 and Big Pickle work through the supported OpenCode CLI, including execution by XVANT's actual WorkerSupervisor. Full durable live XVANT integration does not work in the current implementation. No production source was changed during verification.

Source: `a704bcee0cb81b5874b10311a846445e6c33ba24`, branch `codex/phase-3-offline`. Pinned Node: 24.21.0. Installed OpenCode: 2.0.19. XVANT's OpenCode protocol pin: 1.18.33. Requested model: `opencode/big-pickle`.

## Confirmed passes

- Offline G03: 713 tests, zero failures/skips, 23 gate checks. Types, lint, formatting, runtime checks, controller roster, authenticated synthetic HTTP, interruptions, account blocks and create/resume fixtures pass. Tests include durable storage, snapshot/recovery, crash injection, ownership, stale/forged results and permission boundaries.
- Coverage: statements 94.33%, branches 91.86%, functions 97.38%, lines 95.69%.
- Recomputed source manifest matches the passing receipt exactly: `4e49851db9c2332e86c0ed6d9fe67f3b9a0cf040f29bbf13a9793724b0217ff7`. The gate was run immediately before this broader verification; it was not repeated because source is unchanged.
- Real Big Pickle through the installed CLI under XVANT's unchanged WorkerSupervisor: new session returns a random verification token; explicit resume recalls it with the same session ID.
- Concurrent groups of two and three OpenCode CLI sessions: distinct session IDs, correctly routed exact responses, successful process exits, no truncated output or observed tool-use events. These are OpenCode-only groups, not the plan's mixed 2-Codex/3-Claude/5-OpenCode roster.
- Real OpenCode 2 server authentication: anonymous `/api/info` returns 401; authenticated request returns 200 with version 2.0.19.
- Real v2 session creation and event subscription: a session.created event is received through `/api/event`.
- Explicit v2 API interrupt acknowledges an active request and returns false for a subsequent idle interrupt. This does not establish cancellation during successful model generation because that direct API model route failed authorization.
- XVANT WorkerSupervisor rejects a forged cancellation generation, accepts the owned identity, returns `cancelled`, reaches zero active runs, and leaves the owned server endpoint unreachable.
- Timeout enforcement terminated a CLI request that produced no events within 60 seconds. Model-stream cancellation was not established by that case.
- Final process inventory contains only the pre-existing OpenCode process from 10:17 EDT; test-created OpenCode processes are gone. The existing user process was untouched.
- Git diff is empty and `git diff --check` passes. Existing local evidence remains untracked; verification scripts are in ignored `.artifacts`.

## Observed failures and integration blockers

1. **Live admission is intentionally unavailable.** The real controller rejects runtime 2.0.19 with `VERSION_UNSUPPORTED`. Separately, the journal rejects `classification: live` because its schema permits only `offline`. Both checks leave the task queued; the controller starts no worker. References: `apps/controller/src/opencode-http.ts:110`, `packages/storage/src/providers.ts:28`.
2. **The controller launches a fixed synthetic peer.** `apps/controller/src/opencode-http.ts:309` selects `tests/fixtures/opencode-server.mjs`; no production live launcher was added by installing OpenCode.
3. **Startup and health contracts differ.** OpenCode 2 emits `server listening on ...`; XVANT's parser returns `ENDPOINT_REJECTED`. Its `/global/health` path returns HTML 200 on v2, so the actual XVANT endpoint client returns `ENDPOINT_UNAUTHENTICATED`. V2's actual API authentication passes; this failure is not evidence that v2's API is unprotected.
4. **Event projection differs.** Feeding an observed v2 session.created event to XVANT's pinned projection returns `INVALID_EVENT`. V2 event fields include id, created, type, location, data and durable.
5. **Failure normalization differs.** The observed v2 `provider.auth` error with status 403 maps to `WORKER_FAILED` / attempt / unrecognized in XVANT, rather than account-scoped `AUTH_REQUIRED`. Live admission currently prevents this mismatch from reaching the durable production flow.
6. **Direct HTTP Big Pickle inference is blocked.** The tested `/api/session/.../prompt` route returns a terminal provider error: `403`, `OpenCode's free tier can only be used from within OpenCode`. No header spoofing, access-control workaround, credential substitution or paid fallback was attempted. Direct API create/resume and 2/3/5 model-completion checks failed; their administrative session creation succeeded. The supported CLI route works.
7. **Five-way CLI concurrency is not qualified.** Three calls completed; two exited 1 with `Transport: The socket connection was closed unexpectedly.` All supervisor slots were released. This does not identify the fault as quota, provider capacity or local transport; the cause remains undetermined. Failed calls were not automatically replayed.
8. **Mid-generation CLI cancellation remains unverified.** The probe waited for a step_start event before cancellation, but no event arrived within its 60-second deadline. The supervisor's timeout path worked. A separate owned-server cancellation test passed as described above.

## Limits and next work

No full live G03 claim: durable live dispatch, live result reconciliation/verification/acceptance, cross-runtime routing, live tool-denial handling, real quota handling, attached/history import and Linux execution are not qualified. Linux was unavailable in the earlier host inventory; no Linux environment was installed. Other-provider live execution was outside the authorized OpenCode/Big Pickle route. Later project phases are not implemented and cannot be verified as completed.

The next implementation needs an explicit OpenCode 2 adapter or supported CLI transport, versioned event/error contracts, durable live admission, and tests through the real controller to verification and acceptance. Merely changing the version pin would not fix the observed protocol differences. Resolve the five-way transport failures before claiming that concurrency level.

## Evidence and reproduction

- Offline receipt: [G03.json](G03.json).
- Source attestation: [verification-source-match.json](../../.artifacts/verification-source-match.json).
- Actual server/client checks and direct-API failures: [live-server-verification.json](../../.artifacts/live-server-verification.json).
- Real XVANT supervisor + CLI checks and admission failures: [supervised-live-verification.json](../../.artifacts/supervised-live-verification.json).
- Live event and cancellation checks: [live-boundaries-verification.json](../../.artifacts/live-boundaries-verification.json).
- Probe scripts: `.artifacts/verify-live.mjs`, `.artifacts/verify-supervised-live.mjs`, `.artifacts/verify-live-boundaries.mjs`. These are diagnostic artifacts, not shipped adapters or gate suites. Their JSON assertions are authoritative; script exit zero only means the diagnostic completed, not that every compatibility check passed. Rerunning live scripts makes additional model calls and creates fresh verification sessions.
- Public API reference inspected: https://opencode.ai/v2/docs/api and https://opencode.ai/v2/openapi.json. Runtime observations from installed 2.0.19 take precedence over the rolling documentation.

Review/security/cleanup scope: no pending production diff to review or simplify. Relevant authentication, fail-closed admission, owned-process cancellation and existing offline fault/security tests were checked. This is not a new whole-repository security audit or a hostile-process containment claim.
