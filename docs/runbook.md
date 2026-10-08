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
| Same, with a stronger model planning and reviewing | add `--model claude=haiku --planner-model opus`: one worker plans and reviews on the planner model and implements nothing; the others work on the runtime's model |
| Run one objective and write the real-repository receipt | `node scripts/real-repo-run.mjs --approve-live --repo CLONE --objective "TEXT" --check "COMMAND"` plus any `xvant run` option. Use a throwaway clone. Writes `docs/evidence/G07-live-ui.json`; change no tracked file while it runs |
| List runs, or inspect one | `npm run xvant -- status [ID]` |
| Accept a ready result | `npm run xvant -- accept ID`, then `git merge xvant/<id>` in your repository |

XVANT works in its own worktrees and puts the combined result on an `xvant/<id>` branch. It never changes your checkout or your branches. State is in `%USERPROFILE%\.xvant` (override with `XVANT_HOME`).

When the review rejects the combined result and names defects, XVANT runs one repair turn, then verifies and reviews again. A result that is still rejected is handed over as `ready` with the findings; read the review before accepting.

State acceptance criteria explicitly with `--criterion`. On the benchmark, a small model given explicit criteria passed far more often than the same model given only the objective.

## Runtimes and compatibility

| Runtime | State on 2026-10-03 | What to do |
| --- | --- | --- |
| Claude Code | qualified (2.1.288; 2.1.294 on 2026-10-08) | Nothing. Patch updates within the qualified minor version are accepted. |
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

## Release checks

These are not part of `npm run gate`. Each writes a receipt under `docs/evidence/` and a bundle under `docs/evidence/runs/`, and each fails with "Source changed during the run" if a tracked or untracked file outside `docs/evidence/` changes while it runs.

| Check | Command | Receipt |
| --- | --- | --- |
| Clean install | `node scripts/clean-install-check.mjs [--include-working-tree]` | `P10-clean-install.json` |
| Offline soak | `node scripts/soak.mjs --minutes N [--seed S]` | `P10-soak.json` |
| Package | `node scripts/package-release.mjs [--allow-dirty]` | `P10-package.json` |

**Clean install.** Clones HEAD (without `docs/`, so Windows path lengths stay short) into a temp directory, then runs `npm ci`, `tsc --noEmit`, `xvant runtimes` (exit 0 and three runtime lines, qualified or not), `status` on an empty `XVANT_HOME`, and a backup and restore round trip with a seeded task and object. Needs the network for `npm ci` (the npm registry; nothing paid). Without `--include-working-tree` it tests only what is committed and fails if there are uncommitted changes; with it, it copies your working tree over the clone and the receipt says so. Proves: the committed tree installs and starts from nothing on this host. Does not prove: a different machine, a runtime login, Linux, or an upgrade from an earlier version.

**Soak.** Runs orchestrated objectives against throwaway Git repositories for N minutes. The real orchestrator, store, worktrees, integration and checks run; every turn is a fake that injects faults from a seeded generator (turn failure, unknown outcome, conflicting patches, failing check, rejecting review). After each iteration it checks: the run ended in the phase that fault calls for, an unknown outcome was never retried, the user's checkout (HEAD, branch, status, other branches, files) is unchanged, only the run's own worktrees and `xvant/` branches exist, no temp directory or patch file is left, and process rss has not grown past 1.5 times its post-warm-up level (and 64 MB). The seed is in the receipt; the same seed replays the same fault sequence. Proves: the orchestration invariants hold under those five faults for the time run. Does not prove: anything about a live runtime, quota, or a crash and resume; there is no live soak. `tests/faults/soak.test.ts` runs six iterations as a regression test.

**Package.** Writes `.artifacts/release/xvant-<version>-<commit>-win-x64.zip` (the committed tree from `git archive`, without `docs/` and `.Codex/`), `SHA256SUMS`, and `support-matrix.json` and `.md` built from `package.json`, `.node-version`, the pinned routes in `packages/contracts/src/live.ts` and the receipts in `docs/evidence`. It refuses a dirty tree unless `--allow-dirty` (the archive then still holds only HEAD, and the receipt says so), re-hashes its output and compares the archive's file list with HEAD. The archive is not committed; the receipt records names, sizes and hashes. Proves: the archive matches HEAD and its checksums. Does not prove: that it installs (run the clean-install check), or who made it (nothing is signed).

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

| Task | Command |
| --- | --- |
| Back up the state directory | `npm run xvant -- backup [--out DIR]`. Default `DIR` is `%USERPROFILE%\.xvant-backups\<timestamp>` (next to the state directory, never inside it) |
| Restore into an empty or new state directory | `npm run xvant -- restore --from DIR` |
| Restore over existing state | `npm run xvant -- restore --from DIR --force` |

Both commands honour `XVANT_HOME`. Rules:

- A backup holds `state.sqlite`, written as one consistent snapshot (`VACUUM INTO`, not a file copy), the files in `objects\`, and `manifest.json` with the format version, creation time, XVANT version, schema version and the SHA-256 and size of every file. `DIR` must be empty or new.
- `runs\` is not backed up. Its worktrees belong to the repositories they were created from, and a restored state directory on another machine will not have those repositories. The manifest and the command output say so.
- Both commands refuse while another live XVANT process (`xvant ui`, `xvant run`) owns the state. A backup takes the same lease the app takes, so it also waits out the 30 seconds a crashed process leaves behind; a restore reads the lease and refuses while it is unexpired.
- Restore checks the manifest version and every hash before it touches anything. A missing or altered file, or a format it does not know, is refused and the target is left as it was.
- Restore refuses a state directory that already has content unless you pass `--force`. With `--force` the existing directory is moved, not deleted, to `<state directory>.before-restore-<timestamp>` beside it, including its `runs\`. Delete it yourself once you are sure.
- After the restore XVANT opens the database and runs `PRAGMA integrity_check`; anything but `ok` fails the command.

Do not copy `state.sqlite` by hand while XVANT is running: it can produce a torn copy.

Proves: the backup and restore round trip keeps the same rows and object bytes, and each refusal above (`packages/storage/src/backup.test.ts`). Does not prove: restoring a backup made by another XVANT version (only format 1 exists, and schema upgrades are not tested on restored data), or recovery from a damaged disk.

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
- There is no installer. The packaged artifact is a source archive: unzip it, install Node 24.21.0 and run `npm ci --ignore-scripts` as under Install.
