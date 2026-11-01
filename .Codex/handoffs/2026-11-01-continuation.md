# XVANT continuation: source snapshot before final qualification

Read with `2026-11-01-0157.md`. This is the source-ready handoff; final gate, live-rerun, PR/main and clean-install outcomes will be recorded in **`docs/evidence/2026-11-01-continuation-results.md`**. Do not treat pending checks below as passes. Do not edit this source-hashed handoff after final gate; update only `docs/evidence`.

## Scope and invariants

- Windows `local-v1`, trusted local execution; not Linux qualification or hostile-code containment.
- Subscription/free CLI logins only. Unknown outcomes never auto-retry; auth/quota refusals stop for operator attention rather than switching accounts/runtimes.
- Keep `docs/` and `.Codex/handoffs/` off `main`; archive evidence on feature branches.
- Preserve the two untracked Muse plan files in the primary checkout. No routing promotion or paid-model campaign was authorized.
- No default planner selected. Shell tandem is opt-in, not evidence of a routing-ledger promotion. UI tandem remains unimplemented; existing CLI-surface evidence is not relabeled UI.

## Checkouts / source ownership

- Primary: `C:/Users/jiang/Downloads/xvant/xvant-agent`, `codex/phase-5-tools`; preserves original handoff and failed live-soak evidence.
- Tandem: `C:/Users/jiang/xt`, `claude/tandem`; integration/soak/gate checkout. Passing second soak committed as `dfafe4a`.
- Review fixes: `C:/Users/jiang/xfix`, `fix/local-v1-review`; staged-index safety, oversized scanning, Codex thread provenance, orchestrator authority/refusal fixes, independent-review evidence and benchmark diagnosis.
- Shell fixes: `C:/Users/jiang/xsh`, `fix/shell-review`; durable acceptance/merge checks and one-shot share failure reporting. Its builder exhausted its iteration budget after passing 24 targeted cases, so the parent takes ownership of fresh formatting, typecheck, tests, independent review and integration. A dangling unused test import was removed; no claim of a completed builder handoff.
- Main integration: `C:/Users/jiang/xm`, `main-merge-tmp`; inspected clean before landing. Local `main` is stale; fetch `origin/main` instead.

## Repairs and evidence

1. **Owned Claude cancellation** (`6b20fbb`): admit interruption before init and before awaiting prompt delivery; keep rejected-auth/cancel race conservative. New regressions reproduced failures before fixes. Focused controller/supervisor/gate tests and scoped Codex review passed.
2. **Git-index safety** (`168d4e3`): inspect actual staged blobs before and after staging; refuse excluded, oversized or unscannable staged entries without resetting the user's index. Regressions cover pre-staged `.env` and sanitized working-copy/staged-secret mismatch.
3. **Unscanned share files / Codex creation provenance** (`16a039a`): skip oversized or unreadable worktree files; permit resumed threads created by older already-admitted stable patches of the same major.minor, never future/unqualified history or mismatched new-thread versions. Executable admission unchanged. Codex adapter tests 56/56 and share tests 9/9 passed; independent source review approved. No live resume qualification claimed.
4. **Review authority / account refusals** (`5c85b9f`): only accepted review turns can supply verdict authority; unknown review stops with `needs_attention`. Structured AUTH_REQUIRED/QUOTA_BLOCKED/MODEL_UNAVAILABLE stops implementation, planning, combined-check repair, review and review repair. Parent independently ran 34/34 orchestrator cases; independent review approved, including 21 lightweight probes. Failed/cancelled reviews retain the existing advisory handover with `approve:false`, not a false approval. Explicit-assignee priority for ordinary code repairs remains unchanged.
5. **Shell / CLI** (pending parent landing at this snapshot): `/merge [ID]` invokes a dedicated CLI command. It requires persisted `accepted`, exact repository realpath, correct integration branch/worktree/common Git directory and verified HEAD, then merges the immutable verified commit. Acceptance checks identity too. Git TTY colors use global `-c color.ui=always`; one-shot sharing reports remote/push failure with nonzero exit while continuous retry remains.

Independent original findings and scoped approvals are preserved under `docs/evidence/reviews/2026-11-01/`. Do not call the original broad reviews approvals: both initially failed and caused the fixes above.

## Live soak and runtimes

- First continuation rerun failed because early cancellation poisoned a provider lease; real failure bundle remains committed: `P10-soak-live-20261101T070106527Z-fb05eed8ec52`.
- Second 12-minute run on committed cancellation fix **passed**, 9 iterations, no invariant problems. Both `conflicting_nodes` runs observed a real conflict and finished `ready`; both clean runs reached `ready`. Cancellation had one unknown outcome; it was preserved rather than retried. `check_fails_first` exhausted its repair budget in both trials (allowed, not evidence of a successful check-repair turn).
- Passing bundle: `P10-soak-live-20261101T072218672Z-327020f26fa5`, integrity complete. A further rerun on the final hardening source is planned, not yet established here.
- Claude qualifies on this host. Installed Codex **0.165.0** remains `version_mismatch`; guard was not widened. Historical supported-patch metadata tests do not qualify that executable.

## Benchmarks

`docs/evidence/2026-11-01-strkit-diagnosis.md` records original-workspace host-check replay, independent corroboration, exact missing lexical-prerelease/cross-major-caret assertions, and diagnostic-only temporary-copy passes. Frozen suite, original model outputs and recorded failures remain unchanged. `repair-limiter-tests` visible tests passed before native ENOTFOUND failures and an unverified interruption; no acceptance success is inferred. Leave default/promotion unset pending the operator and stronger comparative evidence.

## Remaining landing procedure

1. Finish parent verification/review of shell changes; integrate bounded fixes into `claude/tandem`, preserving both failed and passed soak bundles.
2. Update gate required-suite minimums for 22 Codex thread cases, 34 orchestrator cases, 9 share cases, 4 shell cases and 20 shell-integration cases. Do not weaken coverage or timeout gates.
3. Final source/docs clean and committed before live rerun/full gate. Pin Node 24.21.0/npm 12 via the PATH below. `.artifacts/run-awake.py` inhibits host sleep only for its command lifetime and resets the thread request afterward; it does not alter power policy.
4. Run fresh final live soak; preserve actual outcome. Run `npm run gate -- --phase 10 --offline`, then `npm run release:check -- --profile local-v1` without source writers. Record real receipts; only evidence commits afterward.
5. Push tandem; comment on PR #1 with receipt/scope and merge into `codex/phase-5-tools` only when verified.
6. In clean `xm`, merge fetched `origin/main` and verified work, then remove tracked `docs/` and `.Codex/handoffs/` as required before pushing `main`. Do not delete original Muse files. Validate a clean clone with `node scripts/clean-install-check.mjs`; it tests install/typecheck/runtimes/backup-restore, not a fresh machine or qualified live logins.
7. Verify remote main/source identity and PR state. Save actual final results in the evidence note linked at top.

```bash
export PATH="/c/Users/jiang/XVANT/.tools/node_modules/node-win-x64/bin:/c/Users/jiang/XVANT/.tools/node_modules/.bin:$PATH"
```

### Known limitations carried forward

Current Codex runtime mismatch; no GUI tandem; CLI-vs-UI requirement still needs human disposition; no hosted/multi-device share trial; no live check-repair success shown by the soak; no Linux qualification; no arbitrary-secret/history scan or hostile concurrent Git-index guarantee; explicit assignments still take precedence during ordinary repairs. Store lease review found no concrete bug, not an all-races proof.
