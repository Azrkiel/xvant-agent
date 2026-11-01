# v2 `write-strkit-tests`: preserved-result diagnosis

## Result

Replayed the frozen host check (`fixtures/benchmarks/v2/tasks/write-strkit-tests/check.mjs`) with pinned Node v24.21.0 against the original retained **benchmark work directories**, not model reruns:

| Configuration | Replay | First surviving mutant |
| --- | --- | --- |
| `claude-haiku-criteria` | failed | text prerelease identifiers compare in reverse |
| `claude-haiku-xvant` | failed | text prerelease identifiers compare in reverse |
| `claude-opus-haiku-xvant` | passed | none |

The two Haiku-only results test numeric-vs-text, numeric-vs-numeric, and shorter prerelease lists, but omit a direct lexical text-vs-text comparison such as `alpha < beta`. Their tests therefore pass when the comparator's text-order return is reversed. This is test-coverage failure, not a runtime/quota failure.

## Bounded diagnostic experiment

Copies of each retained result were made in fresh temporary directories. **Only the copies** were edited; original benchmark records, check, suite lock, source and model outputs remain unchanged.

- Adding `assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)` makes the **Haiku-planned** result pass the full frozen check.
- The same addition exposes a second miss in the **single-worker** result: `^0.x` incorrectly accepting another major is not detected.
- Adding `assert.equal(satisfiesCaret('1.2.3', '0.2.3'), false)` as well makes that diagnostic copy pass the full frozen check.

These diagnostic passes are **not benchmark successes** and do not replace the recorded failures.

## Orchestration observation

The retained Haiku-planned graph ended `ready`, its registered visible check passed, and its review approved with no findings. That review is recorded `independent: false`. The hidden mutation check then rejected the result. The Opus-planned graph's review is recorded independent and its frozen host check replay passes. This supports a concrete missing-coverage explanation, not a general planner-default claim from one repeat.

## Decision

Do not change the frozen v2 task or feed its hidden mutants to production prompts. Do not reclassify or overwrite the campaign. No general orchestration fix is justified by this isolated coverage miss. A future separately frozen suite may make lexical prerelease ordering and zero-major cross-major rejection more explicit in its public criteria. Keep routing promotion/default selection unset pending the operator's decision and stronger comparative evidence.

## Follow-up: `repair-limiter-tests`

The single-Haiku record is an interruption/infrastructure failure, not demonstrated test-quality failure. The saved native transcript (`0475b4bf-0b68-4e43-ab00-5de1a90e4f7d.jsonl`, under the matching Claude project directory) records all four generated test files exiting 0 at line 53, then `getaddrinfo ENOTFOUND api.anthropic.com` at lines 58–61. The independent investigation found a controller interrupt and an unknown outcome without host verification. Visible tests passing is not a substitute for the missing acceptance result; the original record remains unchanged. No live retry was made to reclassify it.

The independent investigation is retained in `reviews/2026-11-01/benchmark-independent.txt`. It independently reproduced two/one/zero surviving frozen mutations for criteria-Haiku/Haiku-orchestrated/Opus-orchestrated and found no modified source in the saved benchmark workspaces.

## Replay pitfall

The controller's saved integration worktrees have different source bytes (line endings) from the retained benchmark work directories and fail the frozen source hash before evaluating tests. They are not interchangeable replay inputs. `benchmark-live.ts` checks out the integration commit into the benchmark work repository before the host check; use that retained work directory for this diagnosis.

Local raw diagnostic outputs: `C:/Users/jiang/xfix/.artifacts/strkit-replay.json` and `strkit-diagnostic.json`.
