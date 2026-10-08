# XVANT plan

Updated 2026-10-03. The [detailed implementation plan](docs/plans/2026-09-26-xvant-implementation-plan.md) owns the phased backlog.

| Phase                                          | State                                                                                       | Evidence                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0: compatibility                               | Windows Node/npm and native SQLite qualified; Linux and live providers open                 | [Compatibility](docs/evidence/compatibility.json)                          |
| 1: contracts and simulation                    | Verified baseline committed as `b91673f`                                                    | [G01](docs/evidence/G01.json)                                              |
| 2: durable controller and execution boundaries | Implemented for Windows offline simulation and trusted-local processes; final status in G02 | [Phase 2 record](docs/phase-02-progress.md), [G02](docs/evidence/G02.json) |
| 3: providers | Offline scope complete: transport, journal, verification, acceptance, interrupt admission, failure normalization/account blocks, controller roster, authenticated OpenCode endpoint. OpenCode 2.0.19 / Big Pickle durable trusted-local text path live verified; mixed live G03, Linux and attached/import ownership open | Current worktree docs/evidence/G03.json; offline-only scope |
| 4: context and handoffs | Offline scope complete on branch `codex/phase-4-context` (through `5071077`): P04.1 sealed packets, P04.2 retrieval, P04.3 fenced project memory (schema v3), P04.4 staleness, P04.5 handoffs, P04.6 inspection, P04.7 import/export. Offline G04 passed 855 tests with a cross-runtime handoff fixture. Live `--fixture handoff` gate open (needs two live runtimes); checkboxes stay open until then | Current worktree docs/evidence/G04.json; offline-only scope |
| 5: tools and skills | Offline scope complete on branch `codex/phase-5-tools` (through `cd37f2f`): P05.1 tool gate + receipts, P05.2 eleven tools + P05.8 browser.inspect (real Edge qualified on this host), P05.3 hashed/pinned skills, P05.4 ten original skills with discriminating fixtures, P05.5 authenticated MCP bridge, P05.6 deduplicated hooks, P05.7 runtime/skill/profile compatibility. Offline G05 passed 965 tests. No live runtime has used the bridge; native-tool restrictions untested live, so read-only profiles are blocked on Codex/Claude/OpenCode | Current worktree docs/evidence/G05.json; offline-only scope |
| 6: orchestration | Offline G06 and live parallel-feature passed (plan, route, integrate, verify, independent review) | Verification register |
| 7: local app | `xvant ui` app + E2E implemented; see latest handoff for gate status | Verification register |
| 8: native loop | Offline G08 passed 2026-10-03 (29 checks, 1128 tests). Live G08 passed with `qwen2.5-7b-instruct` in LM Studio: one small change through `NativeTurnRunner`, host-verified and accepted. `qwen2.5-coder-7b-instruct` fails the tool-call probe | Verification register |
| 9: evaluation | Offline G09 passed (inside G10). Frozen 24-task `v1` suite. Claude `haiku` with stated criteria: 67/72 over 3 repeats, 35/36 held-out. XVANT orchestration with a `haiku` planner: 55/72 at about 3.4 times the tokens, so worse than the single worker on this suite. With an Opus 5.5 planner and reviewer over `haiku` workers (per-role models, 2026-10-08): 23/24 on 1 repeat, 12/12 held-out, no rejected plan; the one failure was a lost store lease. Directional only. After adding one repair turn on a rejecting review, the `haiku`-planned configuration scored 24/24 on 1 repeat (was 55/72 over 3). OpenCode usable again: smoke 8/10. A second frozen suite, `v2`, has eight larger multi-file tasks; no live campaign on it yet. The promotion ledger now governs the routing default (`npm run routing`). Codex and OpenCode baselines unavailable | Verification register |
| 10: hardening | Offline G10 passed (31 checks, 1169 tests) with the release audit; G00 has a receipt; runbook written. Real-repository run passed 2026-10-08 from the command line (`G07-live-ui`), not through the UI. Backup/restore commands, a clean-install check, an offline soak and a packaging script exist (2026-10-08); the soak exposed a store-lease defect, now fixed. Gate (1205 tests), soak, clean-install check and packaging pass after the fix; `release:check --profile local-v1` reports ready. Reviews, a live soak and signing are open | Verification register |

Current code checkout: `C:\Users\jiang\Downloads\xvant\xvant-agent`, branch `codex/phase-5-tools`, latest commit `cd37f2f` (offline G05 passed, 965 tests; Phase 4 on `codex/phase-4-context` at `5071077`, offline G04 passed, 855 tests; Phase 3 live OpenCode committed as `f05a5c9` on `codex/phase-3-offline`). Earlier: `a704bce` (owned authenticated OpenCode endpoint), verified by a fresh pre-commit G03 run (713 tests, receipt source `28b671e` + dirty hash `4e49851d…`). Latest handoff: [.Codex/handoffs/2026-10-03-2042.md](.Codex/handoffs/2026-10-03-2042.md) (what comes next: Opus planner, Muse merge, real-repo run). Previous: [2026-10-03-0055.md](.Codex/handoffs/2026-10-03-0055.md) (the full record of 2026-10-03: G08–G10, benchmark, release check), [2026-10-01-2140.md](.Codex/handoffs/2026-10-01-2140.md) (Phase 8 native loop, repair diagnostics, two runner fixes), [2026-09-30-1905.md](.Codex/handoffs/2026-09-30-1905.md) (live runtimes, G03–G06 live passes, orchestration, CLI, local app). Current per-gate status: [verification register](docs/plans/2026-09-30-verification-register.md); immutable evidence bundles under the code checkout's `docs/evidence/runs/` (verify with 
ode scripts/archive-evidence.mjs --verify`). The original `C:\Users\jiang\XVANT` checkout holds local planning/handoff records and the earlier Phase 2 working tree; preserve it. Plan and handoff files are excluded from published contributions.

## Resume

Read the latest file in [.Codex/handoffs](.Codex/handoffs/), then inspect `git status` in the current code checkout and run 
pm run gate -- --phase 03 --offline` with pinned Node 24.21.0 from `C:\Users\jiang\XVANT\.tools`. The current checkout's G03 receipt and source manifest identify exactly what was tested. No offline receipt completes the live G03 milestone.

## Next sequence

1. Obtain the remaining Linux evidence before claiming cross-platform qualification.
2. OpenCode live text integration is implemented and verified with the approved local Big Pickle route. See current worktree docs/evidence/G03-opencode-live.json. Remaining G03: other-provider approval/version alignment, mixed live roster, broader event/tool coverage, and P03.5 attached/import ownership.
3. Confirm the permitted account/auth route before live provider execution. Subscription-only remains the preference; no paid API fallback is authorized.
4. Add OS containment before untrusted code execution; current trusted-local support is not a sandbox.

## Invariants

- Command + state + event + dispatch intent commit together. Verify ownership before migrating or writing.
- Controller-owned tokens and generations validate worker results. Worker output cannot mint verification receipts.
- `workRevision` binds work; `rowVersion` binds optimistic state changes. Persisted receipts retain their task/attempt/hash binding.
- Unknown outcomes never auto-retry. Keep workspace/session reservations until checks finish or trusted reconciliation proves work stopped.
- Keep capability and test claims host-specific. Configured Linux CI is not an observed Linux pass.
- Keep TLS validation enabled. The pinned SQLite package installs with 
pm ci --ignore-scripts` on this Windows host.

