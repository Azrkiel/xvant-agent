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
| Same, with a stronger model planning and reviewing | add `--model claude=haiku --planner-model opus`: one worker plans and reviews on the planner model and implements nothing; the others work on the runtime's model. A planner model belongs to one runtime: name it with `--model KIND=MODEL` (`KIND=default` keeps that runtime's own model) unless only one runtime is in play |
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
| Codex | `version_mismatch`: the installed version (0.160.1 on 2026-10-08) is not the pinned one | XVANT skips Codex workers. Re-qualify by updating the pinned version in `packages/contracts/src/live.ts` and rerunning `node scripts/live-gate.mjs --phase 03 --fixture roster --approve-live`. |
| OpenCode | qualified (2.0.19); usable again on 2026-10-08 | The provider-side block seen on 2026-10-03 ("OpenCode's free tier can only be used from within OpenCode", `AUTH_REQUIRED`) has cleared: the smoke suite ran 8/10 on `opencode/big-pickle`. If it returns, do not work around it; pass `--only claude`. |
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
| Everything offline, cumulative | `npm run gate -- --phase 10 --offline` | About 8 minutes with 3 GB of free memory, 15 or more without; the test stage is stopped after 20. Fails with "Source changed during verification" if any file changes while it runs |
| Live gates | `node scripts/live-gate.mjs --phase 03\|04\|05\|06\|08 --fixture ... --approve-live` | Uses real sessions |
| Release audit | `npm run audit:release` | Lockfile, licences, tracked secrets, loopback binding |
| What a release still lacks | `npm run release:check -- --profile local-v1` | Exits 0 only when every requirement is met |
| Verify stored evidence | `node scripts/archive-evidence.mjs --verify` | Checks every bundle's hashes |

An offline gate receipt counts only for the exact source tree it ran on. After any source change, rerun the phase 10 gate before a release.

## Release checks

These are not part of `npm run gate`, but `release:check --profile local-v1` requires a passing receipt for each. `npm run release:evidence` runs the three in order (clean install, a 9-minute soak, package); commit first, since packaging refuses a dirty tree. Unlike the offline gate, a receipt from an earlier source tree still counts, and each receipt names the tree it ran on. Each writes a receipt under `docs/evidence/` and a bundle under `docs/evidence/runs/`, and each fails with "Source changed during the run" if a tracked or untracked file outside `docs/evidence/` changes while it runs.

| Check | Command | Receipt |
| --- | --- | --- |
| Clean install | `node scripts/clean-install-check.mjs [--include-working-tree]` | `P10-clean-install.json` |
| Offline soak | `node scripts/soak.mjs --minutes N [--seed S]` | `P10-soak.json` |
| Live soak | `node scripts/soak.mjs --live --approve-live --minutes N [--max-iterations K] [--seed S]` | `P10-soak-live.json` |
| Package | `node scripts/package-release.mjs [--allow-dirty]` | `P10-package.json` |

**Clean install.** Clones HEAD (without `docs/`, so Windows path lengths stay short) into a temp directory, then runs `npm ci`, `tsc --noEmit`, `xvant runtimes` (exit 0 and three runtime lines, qualified or not), `status` on an empty `XVANT_HOME`, and a backup and restore round trip with a seeded task and object. Needs the network for `npm ci` (the npm registry; nothing paid). Without `--include-working-tree` it tests only what is committed and fails if there are uncommitted changes; with it, it copies your working tree over the clone and the receipt says so. Proves: the committed tree installs and starts from nothing on this host. Does not prove: a different machine, a runtime login, Linux, or an upgrade from an earlier version.

**Offline soak.** Runs orchestrated objectives against throwaway Git repositories for N minutes. The real orchestrator, store, worktrees, integration and checks run; every turn is a fake that injects faults from a seeded generator (turn failure, unknown outcome, conflicting patches, failing check, rejecting review). After each iteration it checks: the run ended in the phase that fault calls for, an unknown outcome was never retried, the user's checkout (HEAD, branch, status, other branches, files) is unchanged, only the run's own worktrees and `xvant/` branches exist, no temp directory or patch file is left, and process rss has not grown past 1.5 times its post-warm-up level (and 64 MB). The seed is in the receipt; the same seed replays the same fault sequence. Proves: the orchestration invariants hold under those five faults for the time run. Does not prove: anything about a live runtime, quota, or a crash and resume (the live soak below covers a live runtime, briefly). `tests/faults/soak.test.ts` runs six iterations as a regression test.

**Live soak.** The same loop and the same invariants as the offline soak, with real Claude Code turns on Haiku through `LiveTurnRunner` (the `claude` runtime only, model `haiku` for every role, no planner model). It uses the Claude subscription, so it refuses to start without `--approve-live` or if Claude is not `qualified`; if Claude reports quota or login trouble it stops before the next iteration and says so. Each iteration builds a throwaway repository (three small plain-JavaScript files, no dependencies), a tiny objective with acceptance criteria and a plan supplied up front, and a registered check (a Node script kept outside the repository, run through the shell like `xvant run --check`). Faults come from the environment, one scenario per iteration, chosen by a seeded shuffle so a short run meets each before any repeats: `clean` (expects ready), `check_fails_first` (the check demands a file the objective never mentions, so a repair turn must read it from the check output; ready with a `graph.fix` event or failed when the budget runs out, and the receipt records which), `impossible_check` (the check cannot pass; expects failed, never ready), `cancel_mid_run` (`cancel()` 5 seconds after the first node is dispatched; expects cancelled) and `conflicting_nodes` (two parallel nodes whose objectives rewrite the same line of one shared file; expects a terminal phase, and the receipt records whether an `Integration conflict` repair happened or the model avoided it). After each iteration it checks everything the offline soak checks, and that no process the iteration started is still running: it samples the process table (PowerShell `Get-CimInstance Win32_Process`) before, every 5 seconds during, and after the iteration, follows parent links from the soak process (and from processes seen earlier, since Windows does not re-parent an orphan), and gives leftovers 10 seconds to exit before reporting and stopping them. The receipt records the seed, minutes, iterations, per-scenario phases and observations, the fault counts as seen, the runtime version, the model and the limitations. A live run can take longer than `--minutes`: the last iteration it starts runs to completion (at most 6 minutes). Run it only when no other live campaign is using the subscription and memory is free; the benchmark and the soak both start Claude processes. Proves: for the iterations run, with Haiku, on this host, the orchestration invariants hold when faults come from real turns and real processes, and a cancel leaves no Claude process behind. Does not prove: other models, runtimes or larger objectives, hours of operation, a crash and resume, or another host. The tests (`tests/faults/soak-live.test.ts`) cover scenario selection, the repository and check builders, process tracking and receipt assembly; no live turn runs in the test suite.

**Package.** Writes `.artifacts/release/xvant-<version>-<commit>-win-x64.zip` (the committed tree from `git archive`, without `docs/` and `.Codex/`), `SHA256SUMS`, and `support-matrix.json` and `.md` built from `package.json`, `.node-version`, the pinned routes in `packages/contracts/src/live.ts` and the receipts in `docs/evidence`. It refuses a dirty tree unless `--allow-dirty` (the archive then still holds only HEAD, and the receipt says so), re-hashes its output and compares the archive's file list with HEAD. The archive is not committed; the receipt records names, sizes and hashes. Proves: the archive matches HEAD and its checksums. Does not prove: that it installs (run the clean-install check). It is unsigned unless you pass `--sign-key PRIVATE_KEY`: that signs `SHA256SUMS` with an SSH key through `ssh-keygen` (the public key must be beside it as `PRIVATE_KEY.pub`) and writes `SHA256SUMS.sig`; the receipt records the key fingerprint. Verify with `ssh-keygen -Y verify -f ALLOWED_SIGNERS -I xvant-release -n xvant-release -s SHA256SUMS.sig < SHA256SUMS`, where `ALLOWED_SIGNERS` holds one line, `xvant-release <public key>`. No release has been signed yet: no signing key is configured on this machine.

## Routing default

Which model each role runs on is a versioned default in the state directory (the `routing` folder under `XVANT_HOME`). `xvant run` and the app apply it; `--model` and `--planner-model` override it for one run. With no default recorded, each runtime uses its own model.

| Task | Command |
| --- | --- |
| Show the default, earlier versions and candidates | `npm run routing -- status` |
| Record the first default | `npm run routing -- init --version NAME --model claude=haiku [--planner-model opus]` |
| Propose candidates from a benchmark report | `npm run routing -- candidates --report docs/evidence/REPORT.json` |
| Make a candidate the default | `npm run routing -- promote --candidate VERSION --report docs/evidence/REPORT.json` |
| Go back to the previous default | `npm run routing -- rollback` |

- A candidate is a file nothing reads until it is promoted. Candidates come from the report's tuning tasks only.
- Promotion is refused unless the same report benchmarked the current default too, both on the current orchestration behaviour, with the same number of held-out attempts; the candidate accepted at least as many held-out attempts and shows a measured benefit; and the offline phase 10 gate passed on the current source.
- A planner model applies only to a runtime the default names. If that runtime is absent, or no other worker could implement, planning stays as it was and the run says so.
- Skill versions are not covered: the ledger governs routing only.

## Benchmark

```bash
node scripts/benchmark.mjs --suite v1 --freeze     # only when the suite version changes
npm run benchmark -- --suite v1 --repeats 3 --report docs/evidence/benchmark-v1.json \
  --configurations claude-haiku-criteria,claude-haiku-xvant --approve-live --resume .artifacts/benchmark-v1
# Opus plans and reviews, Haiku works. Opus turns use far more of the subscription limit.
npm run benchmark -- --suite v1 --repeats 1 --report docs/evidence/benchmark-v1-opus-haiku-r1.json \
  --configurations claude-opus-haiku-xvant --approve-live --resume .artifacts/benchmark-v1
```

- `v2` is a second frozen suite: eight larger tasks (9 to 15 source files each, 4 to 7 files changed by the reference solution), six of them shaped for parallel work, all with visible tests. No live campaign has run on it yet.
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

- A backup holds `state.sqlite`, written as one consistent snapshot (`VACUUM INTO`, not a file copy), the files in `objects\`, the routing default with its history and candidates (`routing\`), and `manifest.json` with the format version, creation time, XVANT version, schema version and the SHA-256 and size of every file. `DIR` must be empty or new.
- `runs\` is not backed up. Its worktrees belong to the repositories they were created from, and a restored state directory on another machine will not have those repositories. The manifest and the command output say so.
- Both commands refuse while another live XVANT process (`xvant ui`, `xvant run`) owns the state. A backup takes the same lease the app takes, so it also waits out the 30 seconds a crashed process leaves behind; a restore reads the lease and refuses while it is unexpired.
- Restore checks the manifest version and every hash before it touches anything. A missing or altered file, or a format it does not know, is refused and the target is left as it was.
- Restore refuses a state directory that already has content unless you pass `--force`. With `--force` the existing directory is moved, not deleted, to `<state directory>.before-restore-<timestamp>` beside it, including its `runs\`. Delete it yourself once you are sure.
- After the restore XVANT opens the database and runs `PRAGMA integrity_check`; anything but `ok` fails the command and puts the previous state back.
- A restored database never arrives owned: any lease the backup carried is cleared. A backup whose schema is newer than this XVANT reads is refused.
- **Rolling back an upgrade:** back up before upgrading. If the new version must be abandoned, reinstall the earlier version and run `restore --from DIR --force`. The earlier version cannot open a state directory the newer one migrated (`SCHEMA_UNSUPPORTED`); the restore brings back the state from before, and the migrated state is kept beside it. Work done after the backup is not carried over.

Do not copy `state.sqlite` by hand while XVANT is running: it can produce a torn copy.

Proves: the backup and restore round trip keeps the same rows and object bytes, and each refusal above (`packages/storage/src/backup.test.ts`). The upgrade rollback is tested with a stand-in migration, since no second schema version exists yet. Does not prove: a rollback across a real release pair, or recovery from a damaged disk.

## Recovery

| Symptom | Cause | Action |
| --- | --- | --- |
| A task shows `needs_attention` after a crash or restart | The outcome of a turn is unknown. XVANT never retries unknown outcomes on its own | Inspect the worktree and the task in the app, then cancel or re-run it yourself |
| A gate hangs or runs far longer than 10 minutes | Memory starvation | Close browsers and chat apps until 3 GB is free and rerun. A stage that times out now kills its whole process tree |
| "Source changed during verification" | A file changed during the gate | Rerun with nothing else writing to the checkout; use a separate Git worktree for other work |
| `LEASE_BUSY` on a repair | A previous turn still holds the worker | Should not occur since the 2026-10-01 fix; if it does, the earlier turn's outcome is unknown: treat as `needs_attention` |
| Live gate fails at the probe with a local model | The model does not emit structured tool calls | Load a model that does |
| Every OpenCode turn fails with `AUTH_REQUIRED` | Provider-side block (see above) | `--only claude` |
| `STALE_FENCE` | Another XVANT process took over the state directory while this one was still running | Only one controller may own a state directory. Stop the other process, or let it finish; the fenced one cannot write again. A stall alone no longer causes this: since 2026-10-08 a controller that outlived its lease resumes if nobody took over |

## Known limits

- Windows only. Linux is deferred by the operator and has no observed run.
- Trusted-local execution is not a sandbox: checks and runtime tools run as ordinary local processes.
- Attached or imported sessions (P03.5) are not implemented; XVANT only controls sessions it started.
- There is no installer. The packaged artifact is a source archive: unzip it, install Node 24.21.0 and run `npm ci --ignore-scripts` as under Install.
