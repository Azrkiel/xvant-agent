# A00 offline runner

The integrated acceptance command is `npm run gate -- --phase 10 --offline`.
Run it in a new Git checkout, with no `.tools`, `.env`, provider login, existing
SQLite state, or copied `node_modules`. Installation needs network access;
“offline” describes fixture verification, not an air-gapped dependency install.
Tests whose names contain `live` use local fake peers, not paid sessions.

## Required tools

- Node **24.21.0** (`.node-version`) and npm **12.0.2** (`packageManager`).
  Node's bundled npm is not necessarily the project's npm pin. Verify both.
- Git on PATH, including worktree support. Fixtures set their own Git identity.
- Chromium, or a Chromium-family browser supported by the current fixtures.
  `playwright-core` does not install a browser during `npm ci`.
- OpenSSH client (`ssh` and `ssh-keygen`) with `ssh-keygen -Y sign/verify`.
  Signing fixtures generate disposable keys; no real signing key is required.
- Linux: an init that reaps adopted children, or **Tini 0.19.0 with `-s`** around
  the entire gate. Tini's subreaper flag matters when it is not PID 1.
  `tail -f /dev/null` as PID 1 is insufficient. Keep the process-death assertions.
- Writable checkout, temporary/profile/cache directories, and loopback listeners.
  Use local nonsynchronized storage. The observed runner had 3 CPUs / 9.7 GiB;
  Vitest remains bounded to two workers. The gate allows 20 minutes for coverage
  and 3 minutes per other stage; CI has a separate total job deadline.

`npm ci --ignore-scripts --no-audit --no-fund` works with this lockfile.
`better-sqlite3` **13.0.3** ships platform prebuilds inside its npm tarball (including
Linux x64 and Windows x64); it does not need an install script, external binary
download, system SQLite package, or native compiler on those targets. The clean
Linux smoke test reported SQLite **3.53.4**. Unsupported platforms must establish
their own installation result; do not silently enable arbitrary lifecycle scripts.

## Linux setup

Use a fresh checkout and the pinned Node distribution. Install npm 12.0.2 into a
user-owned tool directory or use `npm install --global npm@12.0.2` on an ephemeral
CI runner. Do not use a global install on a shared workstation without deciding
that scope yourself. Verify `node --version` and `npm --version` afterward.

On Debian/Ubuntu, install Git, `openssh-client`, and `tini`. Use your package
manager's supported privilege flow. Install Chromium through the distribution,
or use the browser revision selected by the locked Playwright version:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/playwright-core/cli.js install --with-deps chromium
node --input-type=module -e 'import {chromium} from "playwright-core"; console.log(chromium.executablePath())'
```

Set `XVANT_BROWSER` to that executable, or leave it unset to discover a supported
system browser. An explicitly set `XVANT_BROWSER`, including an empty value, is
authoritative: invalid registrations fail instead of selecting a different browser.
Set writable `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` when the
runner's normal directories are unavailable. Check SQLite before the long gate:

```sh
node --input-type=module -e 'import Database from "better-sqlite3"; const db=new Database(":memory:"); console.log(db.prepare("select sqlite_version() version").get()); db.close()'
tini -s -- npm run gate -- --phase 10 --offline
```

### Chromium in restricted containers

The baseline cloud runner's `/usr/lib/chromium/chrome-sandbox` was owned by
`nobody`, and user namespaces were unavailable. A direct launch aborted with
“No usable sandbox”; the browser fixture correctly failed. The UI suite uses
Playwright, which already disables the Chromium sandbox by default on Linux.

For **trusted local fixtures in a disposable runner only**, a reproducible
launcher resolves this host limitation:

```sh
mkdir -p .artifacts
cat > .artifacts/chromium-trusted-fixtures <<'SH'
#!/bin/sh
exec /usr/bin/chromium --no-sandbox "$@"
SH
chmod +x .artifacts/chromium-trusted-fixtures
export XVANT_BROWSER="$PWD/.artifacts/chromium-trusted-fixtures"
```

The example uses the ignored `.artifacts/` directory so the launcher does not
change the submitted source. Create it before running the gate. Adjust its
absolute Chromium path for your installation. CI records its chosen browser and
uses the same trusted-fixture setting. This does not qualify browser sandboxing,
hostile content, hostile workers, or network containment. DevTools request
interception, denied external requests, screenshot, profile cleanup, child
cleanup, and all coverage/fault assertions remain required. Use an appropriate
sandboxed host for any browser isolation qualification.

## Windows setup and qualification

Install the same Node/npm pins, Git for Windows, and Windows OpenSSH Client.
Install Chromium with `node node_modules/playwright-core/cli.js install chromium`
and set `XVANT_BROWSER` to its reported executable, or use an installed Edge or
Chrome. Run `npm run gate -- --phase 10 --offline` directly; Tini is Linux-only.
The process supervision tests use Windows `taskkill /T /F` on that platform.
Linux evidence never establishes a Windows pass, and neither establishes
unattended Windows operation. Consult the evidence index for actual results.

## Separately authorized live qualification

Ordinary PR checks need no provider login, model endpoint, API key, repository
write credential, production signing key, or stored user data. Do not add live
commands or secrets to the PR workflow. After separate owner authorization on a
trusted host, inspect `scripts/live-gate.mjs`, discover the pinned runtime
versions, agree budgets and targets, and invoke its explicit `--approve-live`
route, for example `node scripts/live-gate.mjs --phase 03 --fixture roster
--approve-live --concurrency 3`. That command uses real accounts and is **not**
a step to execute as part of A00. Preserve its separately classified receipt;
fixture passes cannot substitute for it.
