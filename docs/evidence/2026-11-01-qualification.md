# 2026-11-01 verified Windows qualification

The integrated candidate passed qualification before any feature merge or main publication.

- Source fingerprint: `2dd7fad8e6b1dad9c6324ad3ef2d3899dcee452a99b7e5e98b0038848007f791`.
- G10: `G10-20261101T173912657Z-2dd7fad8e6b1`, passed; complete receipt bundle, hashes verified against the current checkout.
- Full suite: 1,314 passed, 0 failed, 0 pending, across 109 test files. Coverage: statements 94.14%, branches 89.73%, functions 96.90%, lines 95.43%. Thresholds unchanged.
- Every additional offline gate fixture passed.
- Live: `P10-soak-live-20261101T175136266Z-2dd7fad8e6b1`, passed; 13 iterations, seed 20261008, zero invariant problems. Two actual integration conflicts resolved to ready. Both cancellation scenarios settled without an unknown-outcome message.
- `release:check --profile local-v1`: ready. Linux remains deferred.
- Focused independent reviews are retained under `docs/evidence/reviews/2026-11-01/`; all identified shipping blockers were fixed and re-reviewed.

## Failure preservation and power conditions

Earlier live failures, both 20-minute gate timeouts, and their receipt bundles remain in history and the run archive. No failed receipt was reclassified as passed. The benchmark-v2 suite and historical records were not changed.

The Windows System log established lid/idle Modern Standby transitions during interrupted attempts. A system-only execution-state request had been accepted but did not prevent those transitions on battery. The operator then connected AC power and explicitly approved a temporary display wake request. AC was verified before both final phases; system plus display execution-state acquisition succeeded, and the wrapper reported restoring the prior state after each phase. No persistent power policy was edited.

## Scope and limits

This is the existing trusted-local Windows `local-v1` profile, not Linux or hostile process containment. The live campaign used Claude 2.1.316 / subscription Haiku. No paid API billing route or automatic account/model fallback was introduced. No new desktop/browser UI qualification was performed here. Existing benchmark failures are still failures; see `2026-11-01-strkit-diagnosis.md`.

Tandem remains explicit opt-in; no default promotion was performed. Codex admission remains pinned to the qualified contract; this work does not admit the installed 0.165.0 merely because it is newer.

Final landing and clean-main-install results are recorded separately in `2026-11-01-continuation-final.md`. This evidence note is excluded from the source fingerprint by the existing gate rules; the qualified source snapshot and `.Codex` handoff remain unchanged.
