# A07 — Trusted verification and autonomous promotion

Status: planned. Completion prerequisites: A03 and A06. Read [the overall plan](README.md) first.

## Outcome

Work can be accepted and integrated automatically within owner-configured policy, with evidence for the exact resulting revision. Routine intervention is unnecessary for qualifying work. Unverified, stale, rejected, or unauthorized work cannot pass by optimistic interpretation.

Inspect the native verifier/review controllers, orchestrator combined checks, integration branch, CLI accept/merge paths, tool receipts, and release/evaluation policies. Reuse their artifact binding and explicit host authority.

## Execution

1. Define task-class verification policies: bug fix, feature, refactor, documentation, dependency update, and investigation. Specify required evidence, scope checks, review rules, and permitted promotion targets.
2. Separate trusted acceptance checks from worker-proposed tests. Workers may improve tests, but changing required verifier definitions or acceptance policy needs independent authorization and fresh evidence.
3. Verify artifacts from an immutable candidate snapshot in an appropriate sandbox. Bind receipts to source, dependencies/environment, requirement/spec/policy versions, and verifier versions.
4. Verify integrated changes and required review after repairs. Reject missing verdicts and enforce independence by actual contribution history, not merely a different alias or model name.
5. Build an acceptance decision that explains every satisfied or missing requirement. Preserve explicit manual exception semantics from A01.
6. Implement a serialized integration queue per repository. Compare the target head, update/rebuild the candidate if it moved, and rerun invalidated verification. Promote only the exact accepted result through A03's effect interface.
7. Separate acceptance, PR delivery, merge, and deployment permissions. Record operation identity and remote revision for every promotion. Provide rollback/revert guidance; database or external side effects may require compensation rather than a Git revert.
8. Let eligible low-risk policies complete without confirmation; route exceptional cases to a clear blocked/decision queue.

## Success criteria

- **A07-C1:** Valid authorized work completes through acceptance and integration without routine intervention.
- **A07-C2:** Empty verification, weakened trusted tests, rejected/missing required review, and stale receipts prevent auto-acceptance.
- **A07-C3:** A target-head change before promotion invalidates the relevant candidate checks; untested combinations cannot be merged.
- **A07-C4:** Duplicate commands, crashes around merge, and lost remote replies cause no duplicate logical promotion.
- **A07-C5:** Every promoted revision is traceable to exact evidence and a policy decision; model summaries alone cannot authorize it.
- **A07-C6:** Tests and review execute with appropriate isolation; executing repository tests is not treated as harmless host code.
- **A07-C7:** An explicit manual override remains identifiable and cannot be reused for a different revision or scope.

## Validation and latitude

Inject a failing integrated check, rejected review after the repair limit, forged worker receipt, test-removal patch, changed target head, late review result, and uncertain promotion response. Use a local Git remote and fake remote API for deterministic tests, then an authorized disposable hosted repository for live qualification.

Choose verification profiles and queue implementation. Prefer fewer trustworthy checks over many checks that mirror implementation. Automatic deployment can remain an unsupported profile for the first release; do not imply that automatic merge grants deployment authority.

## Deliverables and handoff

Verification policy implementation, acceptance evaluator, integration queue, promotion effect adapter, and evidence explanations. Publish contracts for A08's remote writes and A10's operator decision views.
