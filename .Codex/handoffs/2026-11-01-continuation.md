# XVANT continuation: Windows tandem landing

Read with `2026-11-01-0157.md`; this records the source-ready continuation before final gate/landing. Final outcomes belong in `docs/evidence/2026-11-01-continuation.md` so writing them does not invalidate the gate's source hash.

## Preserved state and source changes

- Original handoff committed/pushed as `4bf657d` on `codex/phase-5-tools`.
- The requested 12-minute live soak on that branch failed (32 iterations). Its complete bundle is `P10-soak-live-20261101T070106527Z-fb05eed8ec52`; committed/pushed as `fe693a6`. Root cause: cancellation before Claude init fell back to stop/unknown and left `claude-3` reserved, causing later `LEASE_BUSY` refusals. Unknown turns were not retried.
- `C:/Users/jiang/xt` (`claude/tandem`) merged the work branch, including its failed evidence, without conflict.
- `6b20fbb`: host interrupt admission now precedes prompt delivery and does not require Claude init. A cancelled result still requires awaited owned-process shutdown. Admitted-cancel stdin failures continue to shutdown; actual protocol/auth failures stay unknown and reserved. Regression failures observed: `NOT_INTERRUPTIBLE` before init, then `NOT_FOUND` at the blocked-input boundary. Three new tests cover both boundaries and the real auth-parser/cancel race. Gate's required Claude test count updated to 10.
- `C:/Users/jiang/xfix` (`fix/local-v1-review`) is an isolated source-fix worktree based on that commit. `168d4e3` fixes `xvant share` publishing pre-staged credentials: scan index entries before staging, and exact staged bytes afterward; refuse unsafe/oversized/unreadable staged blobs without resetting the user's index. The pre-staged `.env` regression failed before the fix; 8 share tests pass after it.
- No Muse merge or routing promotion/default initialization was performed. The original checkout's two untracked Muse plan files remain untouched.

## Verification already observed

- Pinned Node v24.21.0, npm 12.0.2. Use the `.tools` paths below, not Hermes's Node 22.
- Claude 2.1.316 is qualified. Codex 0.165.0 is `version_mismatch` in XVANT; not admitted. Direct Codex CLI review uses its ChatGPT login and does not qualify XVANT's Codex adapter.
- Source typecheck passes; lint and formatting pass before the sharing fix. Focused cancellation/runner/supervisor/gate tests: 48/48. Shell + offline/live-soak unit suites: 26/26. Piped shell smoke checked queue draining, unknown run-ID errors, settings persistence and restart; no model called.
- Independent Codex reviews of the cancellation patch and staged-secret patch approved their stated Windows trusted-local scope. Earlier requested changes were preserved, not replaced. Files are under `docs/evidence/reviews/2026-11-01/`.
- Second live soak is running on clean committed `claude/tandem` (`6b20fbb`) with seed 20261008, 12 minutes. Observed through iteration 6: cancellation, clean ready, designed impossible-check failures, bounded repair failure, and **a real integration conflict followed by ready**. Check its final receipt/process before declaring it passed or starting another live run. Do not automatically retry an unknown turn.
- `write-strkit-tests` diagnosis and real host-check replays: `docs/evidence/2026-11-01-strkit-diagnosis.md`. Both Haiku-only candidates miss lexical prerelease ordering; the single worker also misses a zero-major/cross-major caret boundary. Original failures and frozen suite remain unchanged; diagnostic copies only were edited.

## To complete / resume safely

1. Finish/read the second live soak in `C:/Users/jiang/xt` (Hermes process `proc_d2143affeac4`), preserve its real receipt and immutable bundle. Keep its source unchanged while it runs.
2. Merge `fix/local-v1-review` into tandem after that run; preserve evidence and any independent review findings. No other source writers during the gate.
3. Run `npm run gate -- --phase 10 --offline`, then `npm run release:check -- --profile local-v1`. Commit only `docs/evidence` afterward. No gate on this final source has passed at the time of this snapshot.
4. Only after passing gates/review: push tandem, comment with receipt, merge PR #1 into the work branch; update the original worktree without disturbing Muse files.
5. Merge the verified work into updated `origin/main` in clean `C:/Users/jiang/xm`; omit `docs/` and `.Codex/handoffs/` as the operator requires. Verify a clean main clone with `node scripts/clean-install-check.mjs` before publishing main. No force push.
6. Record final outcomes in `docs/evidence/2026-11-01-continuation.md`. The original worktree's untracked Muse files are source-hashed; a passing gate on clean tandem is not evidence for arbitrary extra untracked source there.

```bash
export PATH="/c/Users/jiang/XVANT/.tools/node_modules/node-win-x64/bin:/c/Users/jiang/XVANT/.tools/node_modules/.bin:$PATH"
node --version
npm run gate -- --phase 10 --offline
npm run release:check -- --profile local-v1
```

## Limits / operator decisions retained

- Subscription/free logins only; no paid API route. No large Opus campaign authorized here.
- Codex 0.165.0 tandem lifecycle remains unqualified; do not broaden its version guard merely because direct CLI review succeeded.
- `check_fails_first` still exhausts its allowed repair budget; that scenario permits safe failure, not a claim that repair succeeded.
- The G07 real-repository receipt is still CLI-surface evidence. Whether it satisfies the human's UI-run requirement remains open; the release policy accepting it does not prove a UI run occurred.
- Linux remains deferred/unqualified. Independent review identified an unchanged Linux supervisor gap: a SIGTERM-ignoring descendant with independent stdio may outlive root close and cancel escalation. This patch does not fix or qualify that path. Windows approval is ordinary trusted descendants with existing `taskkill /T`, never hostile containment.
- No planner default promotion, no hosted/two-machine `share` qualification, no fresh large benchmark campaign.
