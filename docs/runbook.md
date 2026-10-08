# XVANT runbook

Written 2026-10-03 for the Windows host this project is qualified on. Every command runs from the code checkout with the pinned Node on `PATH`:

```bash
cd /c/Users/jiang/Downloads/xvant/xvant-agent
export PATH="/c/Users/jiang/XVANT/.tools/node_modules/node-win-x64/bin:/c/Users/jiang/XVANT/.tools/node_modules/.bin:$PATH"
node --version   # must print v24.21.0
```

Current status lives in the [verification register](plans/2026-09-30-verification-register.md). This file says how to operate; it does not claim anything passed.

## Install

1. Install Node 24.21.0 (the version in `.node-version`) and Git.
2. `npm ci --ignore-scripts`. The lockfile pins every package by sha512 hash. If a managed Windows trust store blocks the registry, set `NODE_USE_SYSTEM_CA=1`; do not disable TLS verification.
3. `node scripts/g00.mjs` records the environment and shows which runtimes are usable. It runs no model turn.
4. Log in to each runtime you want with its own tool (`claude`, `codex`, `opencode`). XVANT never reads or stores credentials.
5. Check that no metered-API key is set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and similar). G00 fails if one is visible, because a runtime could then bill an API instead of a subscription.

## Daily use

| Task | Command |
| --- | --- |
| See which runtimes are qualified | `npm run xvant -- runtimes` |
| Open the local app | `npm run xvant -- ui` |
| Run one objective from the terminal | `npm run xvant -- run --repo PATH --objective "TEXT" --criterion "TEXT" --check "COMMAND" --only claude` |
| List runs, or inspect one | `npm run xvant -- status [ID]` |
| Accept a ready result | `npm run xvant -- accept ID`, then `git merge xvant/<id>` in your repository |

XVANT works in its own worktrees and puts the combined result on an `xvant/<id>` branch. It never changes your checkout or your branches. State is in `%USERPROFILE%\.xvant` (override with `XVANT_HOME`).

State acceptance criteria explicitly with `--criterion`. On the benchmark, a small model given explicit criteria passed far more often than the same model given only the objective.

## Runtimes and compatibility

| Runtime | State on 2026-10-03 | What to do |
| --- | --- | --- |
| Claude Code | qualified (2.1.288) | Nothing. Patch updates within the qualified minor version are accepted. |
| Codex | `version_mismatch`: the installed 0.159.0-alpha.12.1 is not the pinned version | XVANT skips Codex workers. Re-qualify by updating the pinned version in `packages/contracts/src/live.ts` and rerunning `node scripts/live-gate.mjs --phase 03 --fixture roster --approve-live`. |
| OpenCode | version qualified, but every turn fails with `AUTH_REQUIRED` | The provider answers "OpenCode's free tier can only be used from within OpenCode" to `opencode run`. Do not work around it. Pass `--only claude` so no work is routed to OpenCode. |
| Native local model | `qwen2.5-7b-instruct` in LM Studio qualifies | `lms server start`, then `lms load qwen2.5-7b-instruct -c 16384 -y`. Models that answer tool calls as text (for example `qwen2.5-coder-7b-instruct`) fail the probe and cannot be used. |

A runtime that updates itself can stop being qualified without any change in this repository. `npm run xvant -- runtimes` is the quick check.

## Quota and billing

- Only subscription or free logins are used. There is no API fallback, and none may be added.
- A quota or authentication stop is recorded as blocked or incomplete. XVANT does not retry it and does not move the work to a paid route.
- When a runtime is out of quota, restrict the pool with `--only`. Work already accepted is unaffected.
- Benchmark campaigns record a quota-stopped attempt as `incomplete`. It counts against the success rate and is never rerun in the same campaign. An attempt whose controller lost its store lease in a host stall is also `incomplete`, with a reason starting `host:`.

## Gates and evidence

| Purpose | Command | Notes |
| --- | --- | --- |
| Environment and runtime matrix | `node scripts/g00.mjs` | No model turn |
| Everything offline, cumulative | `npm run gate -- --phase 10 --offline` | About 8 minutes; needs 3 GB of free memory. Fails with "Source changed during verification" if any file changes while it runs |
| Live gates | `node scripts/live-gate.mjs --phase 03\|04\|05\|06\|08 --fixture ... --approve-live` | Uses real sessions |
| Release audit | `npm run audit:release` | Lockfile, licences, tracked secrets, loopback binding |
| What a release still lacks | `npm run release:check -- --profile local-v1` | Exits 0 only when every requirement is met |
| Verify stored evidence | `node scripts/archive-evidence.mjs --verify` | Checks every bundle's hashes |

An offline gate receipt counts only for the exact source tree it ran on. After any source change, rerun the phase 10 gate before a release.

## Benchmark

```bash
node scripts/benchmark.mjs --suite v1 --freeze     # only when the suite version changes
npm run benchmark -- --suite v1 --repeats 3 --report docs/evidence/benchmark-v1.json \
  --configurations claude-haiku-criteria,claude-haiku-xvant --approve-live --resume .artifacts/benchmark-v1
# Opus plans and reviews, Haiku works. Opus turns use far more of the subscription limit.
npm run benchmark -- --suite v1 --repeats 1 --report docs/evidence/benchmark-v1-opus-haiku-r1.json \
  --configurations claude-opus-haiku-xvant --approve-live --resume .artifacts/benchmark-v1
```

- The suite is frozen by hash. Changing a task, its repository or its check stops every run until the suite gets a new version and lock.
- `--resume` continues a campaign; recorded attempts never rerun.
- If a runtime updates itself mid-campaign, its turns are refused (`VERSION_UNSUPPORTED`). The campaign then prints `stopped early`, writes no record for that attempt and exits; rerun the same command with the same `--resume` directory.
- Each orchestrated attempt runs up to three Claude processes. With little free memory the host can stall or the run can be killed; nothing recorded is lost, so resume.
- Keep the laptop awake and the lid open. A live campaign asks Windows not to idle-sleep, but closing the lid still suspends it, and an attempt the host slept through is recorded as incomplete.

## Backup and restore

There is no backup command yet. With XVANT stopped (no `xvant ui` or `xvant run` process):

1. Copy the whole state directory (`%USERPROFILE%\.xvant`): `state.sqlite` with any `-wal` and `-shm` files beside it, `objects\` and `runs\`.
2. To restore, stop XVANT, replace the directory with the copy, and start again.

Copying `state.sqlite` while XVANT is running can produce a torn copy. Worktrees under `runs\` belong to the repositories they were created from; a restored state directory on another machine will not have those repositories.

## Recovery

| Symptom | Cause | Action |
| --- | --- | --- |
| A task shows `needs_attention` after a crash or restart | The outcome of a turn is unknown. XVANT never retries unknown outcomes on its own | Inspect the worktree and the task in the app, then cancel or re-run it yourself |
| A gate hangs or runs far longer than 10 minutes | Memory starvation | Close browsers and chat apps until 3 GB is free and rerun. A stage that times out now kills its whole process tree |
| "Source changed during verification" | A file changed during the gate | Rerun with nothing else writing to the checkout; use a separate Git worktree for other work |
| `LEASE_BUSY` on a repair | A previous turn still holds the worker | Should not occur since the 2026-10-01 fix; if it does, the earlier turn's outcome is unknown: treat as `needs_attention` |
| Live gate fails at the probe with a local model | The model does not emit structured tool calls | Load a model that does |
| Every OpenCode turn fails | Provider-side block (see above) | `--only claude` |

## Known limits

- Windows only. Linux is deferred by the operator and has no observed run.
- Trusted-local execution is not a sandbox: checks and runtime tools run as ordinary local processes.
- Attached or imported sessions (P03.5) are not implemented; XVANT only controls sessions it started.
- No installer or packaged artifact exists yet (P10.6).
