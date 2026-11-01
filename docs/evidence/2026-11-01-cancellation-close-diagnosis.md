# Windows cancellation late-close diagnosis

Qualification scope: trusted-local Windows `local-v1`; not Linux or hostile process containment.

## Preserved failure

The final-source 12-minute soak failed after 53 iterations. Receipt and bundle `P10-soak-live-20261101T080258626Z-0ed64ee25a2a` remain unchanged. Its cancelled first graph left `claude-3` reserved with an unknown provider outcome. Subsequent independent graphs correctly refused to reuse that reserved worker and reported `needs_attention`. The chained offline gate and release check did not run.

## Isolated cause and regression

Fresh isolated diagnostic stores/worktrees used the real Claude 2.1.316 executable, a 500 ms interrupt after native-turn process start, and the existing supervisor. Original unknown operations were not reconciled or retried. Instrumentation recorded helper exit, owned exit/close, supervisor result and provider settlement; it did not invent native frames or bypass admission.

Before the fix, `xcd-97mR5y.json` and `xcd-vUCbhN.json` show forceful `taskkill` exit 128, then owned exit/close at 5813 ms and 5840 ms respectively. Both become `needs_attention`/unknown even though the owned process closes within the unchanged seven-second shutdown bound. Other pre-fix trials with helper exit 0 settle cancelled. This distinguishes a helper-error race from missing process-close evidence.

A deterministic mocked-process regression reproduced `expected 'needs_attention' to be 'cancelled'` before the production change. The companion no-close case confirms that deadline expiry still retains uncertain ownership. The production change is Windows-only: a failed helper does not permanently replace the requested stop reason before observing owned close; the existing deadline still fails closed. Identity guards, kill mechanism, deadline, non-Windows behavior and `treeContainment=false` remain unchanged.

## After-change evidence

Three fresh isolated live trials (`xcd-Qanws7.json`, `xcd-v8gzFH.json`, `xcd-3InNqd.json`) all settled cancelled/reconciled with no worker reservation. Crucially, `xcd-v8gzFH.json` reproduces forceful helper exit 128 followed by owned close at 2541 ms, now correctly producing cancelled. This does not itself establish full release or soak qualification.

Actual traces and the diagnostic harness are in `diagnostics/2026-11-01-cancel-close/`. The initial `xcd-pd4B7d.json` trace lacks helper-level instrumentation and is not used to claim a particular helper exit code.

Focused independent review is recorded as `reviews/2026-11-01/late-close-final.json`. Consult final gate/live receipts and the final continuation evidence note for qualification and landing outcomes; those outcomes were not known when this diagnosis was written.
