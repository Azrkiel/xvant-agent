# XVANT verification register

Reconciled 2026-09-30 (updated the same evening after the live gates, and on 2026-10-01 for Phase 8) from the [scope audit](../../.Codex/handoffs/2026-09-30-1039.md) and immutable evidence bundles. It supersedes the status cells in the [release gates](2026-09-26-xvant-release-gates.md) register. The requirements in that file still apply.

Bundles live in `C:/Users/jiang/Downloads/xvant/xvant-agent/docs/evidence/runs/<bundleId>/`. Each holds `receipt.json`, the exact artifact bytes the receipt declares, and `bundle.json` with hashes. Run `node scripts/archive-evidence.mjs --verify` to re-check every bundle. Since this date, `npm run gate` and `npm run probe:live:opencode` write a bundle for every run, including failed runs.

Status vocabulary: **passed** (checks ran on a recorded source hash with retained artifacts), **passed-partial-artifacts** (the receipt passed, but some declared bytes were overwritten before archival), **failed**, **not_run**, **blocked** (a named dependency is missing), **not_implemented**.

## Gate status

| Gate | Offline (Windows) | Live | Linux | Evidence | Named gap |
| --- | --- | --- | --- | --- | --- |
| G00 | **passed** 2026-10-03 (`scripts/g00.mjs`): pinned Node, git, native SQLite, runtime matrix, no metered-API key visible. Records Codex as `version_mismatch` (0.159.0-alpha.12.1) | Auth read live: Codex `chatgpt/plus`, Claude `claude.ai` Pro (`apiKeySource: none`), OpenCode free model at cost 0; runtime discovery by install location | not_run (deferred by operator) | compatibility.json; `scripts/xvant.mjs runtimes` | Formal G00 receipt file not written; Claude auto-updates, so patch updates within the qualified minor are accepted and re-qualified by the live gates |
| G01 | passed-partial-artifacts; covered again by cumulative G05 | n/a | not_run | `G01-20260926T174838004Z-35b98ef5b386` | Original tests/runtime logs overwritten; G05 reruns the suites |
| G02 | passed (original root, complete); passed-partial-artifacts (shared root) | n/a | not_run | `G02-20260927T001137506Z-e373b7507a82`, `G02-20260927T133607700Z-88316de6c21c` | Clean-install and upgrade/rollback campaign; recovery checklist mapping (below) |
| G03 | passed (in cumulative G06) | **passed**: 2 Codex + 3 Claude + 5 OpenCode, distinct sessions, host-verified, accepted after restart; 1 resume and 1 live interrupt per runtime | deferred | `G03-live-roster-20260930T185719183Z-2c63bdeaf711` (commit 8f40a8a) | P03.5 attached/imported-session control not implemented (managed sessions only) |
| G04 | passed (in cumulative G06) | **passed**: Codex sender → Claude recipient from the sealed packet alone; 8/8 facts, no sentinels in prompt or result | deferred | `G04-live-handoff-20260930T191739946Z-7637c52758f9` (commit 24b4df3) | — |
| G05 | passed (in cumulative G06) | **passed**: all three runtimes called XVANT `file.read` through the authenticated task-scoped MCP bridge | deferred | `G05-live-mcp-20260930T191628832Z-7637c52758f9` (commit 24b4df3) | Read-only profiles stay blocked: native tool restrictions are not live-tested; trusted-local with acknowledged bypass is the supported profile |
| G06 | **passed** 1050 tests, 28 checks incl. orchestration fixture | **passed**: planner split server/web/README, workers on two runtimes, independent Codex review (4th run; runs 1–3 found real defects, fixed) | deferred | `G06-20260930T194252197Z-9eaadf3f69b6` (commit 224fdb4); live `G06-live-parallel-feature-20260930T202512212Z-bb2a7fbf8131` | — |
| G07 | **passed** 1062 tests, 28 checks: app API security/flows + Edge E2E (keyboard, reload, double submit, stop, XSS-as-text) | not_run (no real-repo UI run yet) | deferred | `G07-20260930T230043374Z-bf8393a423da` | Real-repo run through the UI; broader accessibility audit |
| G08 | **passed** 2026-10-03: 29 checks, 1128 tests, `native-loop-fixture` 11/11 checks and 10/10 skill fixtures. Two earlier runs failed and are kept: 2026-10-01 starved of memory; 2026-10-03 on a stale `phaseSuites('08')` assertion and a git CRLF warning in the fixture log | **passed** 2026-10-03: `qwen2.5-7b-instruct` Q4_K_M in LM Studio over loopback HTTP passed the tool-call probe and added `clamp` through registry tools (3 `file.read`, 1 `file.apply_patch`, 1 `test.run`); host check passed, task accepted as `native-local`, 31 s. `qwen2.5-coder-7b-instruct` **failed** the probe (emits tool calls as `<xml>` text) and ran no turn | not_run | `G08-20261003T043948791Z-e9c55cbe28d2` (offline pass), `G08-live-native-20261003T045034190Z-e9c55cbe28d2` (live pass); failed: `G08-20261001T235526749Z-6db32cdf2102`, `G08-20261003T043204305Z-dc0fb0867fd6`, `G08-live-native-20261003T044529610Z-e9c55cbe28d2` | Live pass covers one small single-file change on one model; multi-file work, repair rounds and an orchestrated root on a local model are unqualified |
| G09 | **passed** 2026-10-03 inside the cumulative G10 run: evaluation suites plus the benchmark fixture (frozen 24-task `v1` suite: reference solution 24/24, no change 0/24). Harness: suite freeze, hidden host checks, resumable records, report, promotion rules, rollback ledger | **complete for Claude only**: `v1`, 3 repeats, 144 attempts, none incomplete. Single Claude `haiku` worker with stated criteria: 67/72 accepted (93%), 35/36 held-out, 170,668 tokens, median 31 s, 20 of 24 tasks passed every repeat. XVANT orchestration on `haiku` (planner, workers, review): 55/72 (76%), 30/36 held-out, 580,626 tokens, median 96 s, 13 of 24 tasks passed every repeat; 3 of its 17 failures were plans XVANT rejected (`PLAN_INVALID`), the rest failed the hidden check; one repair round fired. On parallel-shaped tasks: 11/12 single worker, 10/12 orchestrated. Orchestration with a Haiku planner is therefore worse and about 3.4 times the tokens on this suite. **Opus planner, 2026-10-08** (`claude-opus-haiku-xvant`: Opus 5.5 plans and reviews, two `haiku` workers implement; 1 repeat, so directional; report `docs/evidence/benchmark-v1-opus-haiku-r1.json`): 23/24 accepted (96%), 12/12 held-out, 4/4 parallel-shaped, median 145 s, no rejected plan and no hidden-check failure. The one failure (`diagnose-off-by-one`) was a lost store lease (`STALE_FENCE`) after a valid plan, not the work. Recorded tokens (85,924) may leave out the Opus turns and are not comparable. 10 attempts ran on Claude Code 2.1.293 and 14 on 2.1.294 after the CLI updated itself mid-campaign; five attempts refused for that reason (`VERSION_UNSUPPORTED`, no worker turn) were set aside in `.artifacts/benchmark-v1/records.version-refused-2.1.294.jsonl` and rerun. With one repeat, 96% against the single worker's 93% is not a real difference; what it shows is that the Haiku-planner penalty is gone, at about four times the single worker's wall time. Smoke-suite samples (1 repeat): `haiku` 8/10 bare, 7/10 with skill text, 10/10 with criteria, 9/10 orchestrated; `native-local` Qwen2.5-7B 1/10. OpenCode **blocked** by its provider (`AUTH_REQUIRED`); Codex out of quota and `version_mismatch` | not_run | `G10-20261003T183723441Z-b872fd5a369b`; `docs/evidence/benchmark-v1.json`, `benchmark-smoke-*.json` (reports, not gate bundles) | Orchestration with a stronger planner (e.g. `sonnet` planner, `haiku` workers) is untested; the suite's tasks are small, so the parallel benefit is barely exercised; Codex and OpenCode baselines; candidate generation (P09.4); the ledger is not read by routing or skills; human rework unmeasured |
| G10 | **passed** 2026-10-03: 31 checks, 1169 tests, cumulative over G01–G09, plus the release audit (lockfile, licences, tracked secrets, loopback binding). Rerun on the final source of this session; the current receipt is `docs/evidence/G10.json` | not_run | not_run | `G10-20261003T183723441Z-b872fd5a369b` | `release:check` for local-v1 lacks a real-repository UI run (`G07-live-ui`, which no script writes yet). Any later source change makes the G10 receipt stale again. Open Phase 10 work: reviews (P10.1), soak (P10.2), clean install and backup/restore verification (P10.3), packaging (P10.6). Runbook written (`docs/runbook.md`) |

## Phase 3 obligations

| ID | Offline | Live | Evidence | Remaining |
| --- | --- | --- | --- | --- |
| P03.1 inventory/probes | passed | inventory only | `scripts/probe.mjs`, compatibility.json | General live qualification runner; `--inventory-only` resolves only `<kind>.exe` on PATH, so it misses the Codex install and the OpenCode `.cmd` shim; record unavailable and failed separately |
| P03.2 Codex | passed (transport fixtures) | not_run | G03/G05 `codex-transport.log` | Real managed worker lifecycle; needs an approved account route |
| P03.3 Claude | passed (native fixtures) | not_run | G03/G05 `claude-*.log` | Re-pin the fixture to 2.1.285 or pin the runtime; then the real lifecycle; needs an approved account route |
| P03.4 OpenCode | passed | CLI text passed; HTTP not_run | `G03-opencode-live-*` bundles | Record the CLI substitution decision or qualify HTTP; tool/permission events; cancellation during generation |
| P03.5 ownership/history | partial (journal, imports) | not_run | G04/G05 suites | Attached read-only vs control, foreign-session refusal, no vendor-file mutation |
| P03.6 mixed roster | passed (10 synthetic) | not_run (OpenCode-only 2/3 historical; 5-way had 2 socket failures) | `controller-roster.log` | Real 2 Codex + 3 Claude + 5 OpenCode |
| P03.7 failures | passed (synthetic) | partial (OpenCode auth/transport observations) | `*-native-quota.log` | Per-adapter real auth, model-unavailable, and quota observations; interrupting a real generation |
| P03.8 quota/usage | passed (synthetic) | not_run | store tests | Cross-runtime account identity; usage categories; unknown recorded as unknown |

## Cross-cutting campaigns (release-gates checklists)

These checklists are not yet mapped test-by-test. Each row names the suite that covers it, if any. An unlisted item is a gap.

| Campaign | Covered offline by | Gap |
| --- | --- | --- |
| Recovery injection (14 boundaries) | `tests/faults/crash.test.ts`, `apps/controller/src/durable.test.ts`, `packages/storage/src/store.test.ts` | Per-boundary mapping; migration and backup failure during a live run; UI state (G07) |
| Security/privacy (16 items) | `apps/controller/src/http/server.test.ts`, `packages/policy`, `packages/tools`, `packages/context` handoff sentinels | Native vendor-tool bypass (live); Windows UNC/device/junction coverage audit; license record |
| UI (18 items) | none | All items; G07 is not_implemented |
| Evaluation (11 items) | none | All items; G09 is not_implemented |

## Release profiles

- **local-beta** needs G00–G07 plus the G10 install/recovery checks. It is blocked on live G03–G05, G06, G07, and Linux.
- **local-v1** needs G00–G10, including live G08. It is blocked on everything above plus G08–G10.

## Decisions needed from the operator before live work

1. The Codex and Claude account routes, auth category, and spending limits. Subscription only; no paid fallback.
2. Whether the OpenCode CLI transport formally replaces the async-HTTP objective.
3. A Linux host and a local-model host, or an explicit "unavailable" record.
4. The target release profile (local-beta or local-v1).
