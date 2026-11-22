# A04 installed-service qualification

On a disposable Linux machine approved for reboot and physical suspend, run
both cases with the checked-out A04 draft and the systemd user unit. The
[service handoff](https://github.com/Azrkiel/xvant-agent/blob/560c487f7d049dc3dab16b2170fdc4d9ce1c4969/docs/a04-daemon.md)
describes installation and rollback. Use the [A00 toolchain](a00-runner.md).
Choose a physical suspend mode supported by the machine and arrange a wake
path before starting. Keep the service account, local SQLite volume,
repositories, and receipt directory across both transitions. Use empty
offline fixture repositories and the checked-in fixture runner.

The reference tested revision is `560c487f7d049dc3dab16b2170fdc4d9ce1c4969`,
with A03 base `845048ab6831e25b2b44b4747bb648ba83afd3e8`. Record the checked-out
SHA and the current PR base SHA. If the head changes, check the fixture and
unit on the new revision and use its evidence.

## Install and prepare

Use the provided service unit and the pinned Node path documented in the
service handoff. Enable lingering for the dedicated account so a service
start after boot can be observed before interactive login. Use a fresh
state and fixture directory for each case. In this example use
`$HOME/a04-host-reboot` for C1 and `$HOME/a04-host-suspend` for C6.
Stop the prior case's unit before changing its environment file.

```sh
umask 077
export SOURCE="$HOME/.local/share/xvant/source"
export CASE="$HOME/a04-host-reboot"
export XVANT_HOME="$CASE/state"
export PATH="$HOME/.local/share/xvant/node/bin:$PATH"
mkdir -p "$CASE/fixture" "$CASE/captures" "$HOME/.config/xvant"
cd "$SOURCE"
git status --short
git rev-parse HEAD
node --version
npm --version
git --version
ssh -V
chromium --version
tini --version
systemctl --version
uname -srmo
npm ci --ignore-scripts --no-audit --no-fund
install -Dm 644 "$SOURCE/deploy/systemd/xvant-daemon.service" \
  "$HOME/.config/systemd/user/xvant-daemon.service"
cat > "$HOME/.config/xvant/daemon.env" <<EOF
XVANT_HOME=$XVANT_HOME
XVANT_DAEMON_CONFIG=$SOURCE/tests/fixtures/daemon-runner.ts
XVANT_DAEMON_FIXTURE_DIR=$CASE/fixture
XVANT_DAEMON_WORKERS=2
EOF
systemctl --user daemon-reload
systemctl --user enable --now xvant-daemon.service

xvant() { node "$SOURCE/scripts/xvant.mjs" daemon "$@"; }
for name in held queued waiting; do
  git init -q "$CASE/$name"
  git -C "$CASE/$name" -c user.name=fixture -c user.email=fixture@example.test \
    commit --allow-empty -qm base
done

xvant submit --id hold --repo "$CASE/held" --objective hold-root \
  --only codex --max-active 1 --no-review > "$CASE/captures/held-ack.json"
held=$(node -p 'require(process.argv[1]).id' "$CASE/captures/held-ack.json")
```

Watch `$CASE/fixture/calls` for the first planning turn of `$held`.
Immediately run `systemctl --user stop xvant-daemon.service` from the
same case after the turn starts. The stock fixture's held child has a
12-second limit. Start the unit again and require an unresolved planning
dispatch before proceeding. This setup intentionally creates a known
uncertain effect with an unreleased reservation.

```sh
systemctl --user start xvant-daemon.service
xvant status "$held" > "$CASE/captures/held-initial.json"
xvant submit --id wait --repo "$CASE/waiting" --objective fixture \
  --only claude --max-active 2 --no-review > "$CASE/captures/wait-ack.json"
waiting=$(node -p 'require(process.argv[1]).id' "$CASE/captures/wait-ack.json")
```

Require `held-initial.json` to show a blocked job and a recovery decision
of `block`. Require `xvant status "$waiting"` to reach
`WORKER_LIMIT_RECONCILIATION`, with zero fixture calls for that run.
The two-slot job makes the retained reservation observable. The queued
test job below uses one slot and a disjoint worker.

## C1 host reboot

Pause dispatch, submit the queued fixture, and move its disposable target
head after acknowledgment. Record the original Git revision. Capture the
before state as shown below. Reboot through the approved system console
with `systemctl reboot`. After reboot, capture the system boot ID and the
service start record before issuing any service start command.

```sh
xvant pause-dispatch --id pause
git -C "$CASE/queued" rev-parse HEAD > "$CASE/captures/queued-base.txt"
xvant submit --id queued --repo "$CASE/queued" --objective fixture \
  --only claude --max-active 1 --no-review > "$CASE/captures/queued-ack.json"
git -C "$CASE/queued" -c user.name=fixture -c user.email=fixture@example.test \
  commit --allow-empty -qm moved-after-ack
install -m 600 "$XVANT_HOME/daemon/endpoint.json" "$CASE/old-endpoint.private"
```

After reboot require a different boot ID, one higher service generation,
and the same queued job, due instant, receipt and pinned base. Replay the
same submission and compare its JSON acknowledgment with the original.
Run `xvant continue --id continue-after-reboot`. Observe the queued root
advance through its normal A04 path while the blocked two-slot job remains
unable to claim. Verify that exactly one planning dispatch occurred for the
queued root. Its ready result should reference the original Git base.

## C6 physical suspend and resume

Use the separate case directory and a fresh service state. Create the
blocked effect and the two-slot waiting job as above. Leave dispatch
enabled. Submit the one-slot cohort with a future due time. Choose the
lead time and sleep duration in advance. Enter suspend before the due
instant and wake after it.

```sh
due=$(date -u -d '+60 seconds' +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$due" > "$CASE/captures/suspend-due.txt"
xvant submit --id queued --repo "$CASE/queued" --objective fixture \
  --only claude --max-active 1 --no-review --due-at "$due" \
  > "$CASE/captures/queued-ack.json"
cat /sys/power/mem_sleep > "$CASE/captures/mem-sleep-modes.txt"
```

Capture the before state, including the absent planning call for the
queued root. Suspend with `systemctl suspend` via the approved console.
Capture the after state and the kernel PM suspend entry and exit messages
from the current boot. Require an unchanged boot ID, a due instant crossed
during the observed sleep interval, and one legal planning dispatch for the
eligible root. Compare the unit invocation and owner generation before
and after. A resumed invocation should retain its owner and generation.
If a competing owner took over, record the cause and require one
generation advance and fencing of the obsolete owner. Record latency from
the observed wake to dispatch. Record the unresolved action's unchanged absolute deadline,
dispatch identity and held resources. Preserve the existing simulation
evidence for backward and forward wall-clock jumps.
Capture kernel messages with `journalctl -b -k -o short-unix -g 'PM: suspend (entry|exit)'`.
Use the queued planning intent time in `journal.json` as the dispatch
timestamp and compare it with the matching kernel wake time. Use the
existing two-second fixture allowance after wake, and retain any timing
failure with the host's wake and dispatch observations.

## Before/after evidence and ownership

After each transition, reestablish the exported shell variables and the
`xvant` function if the prior session disconnected. Run this capture block
twice per case, with `label=before` and `label=after`.

```sh
queued=$(node -p 'require(process.argv[1]).id' "$CASE/captures/queued-ack.json")
held=$(node -p 'require(process.argv[1]).id' "$CASE/captures/held-ack.json")
waiting=$(node -p 'require(process.argv[1]).id' "$CASE/captures/wait-ack.json")
capture="$CASE/captures/$label"
mkdir -p "$capture"
date --iso-8601=ns > "$capture/wall-time.txt"
cat /proc/sys/kernel/random/boot_id > "$capture/boot-id.txt"
cat /proc/uptime > "$capture/uptime.txt"
systemctl --user show xvant-daemon.service \
  -p ActiveState -p MainPID -p InvocationID -p ActiveEnterTimestamp \
  > "$capture/service.txt"
xvant status > "$capture/daemon.json"
for id in "$held" "$waiting" "$queued"; do
  xvant status "$id" > "$capture/$id.json"
done
cp "$CASE/fixture/calls" "$capture/calls.jsonl"
node --input-type=module - "$XVANT_HOME/state.sqlite" "$held" "$queued" \
  > "$capture/journal.json" <<'NODE'
import Database from 'better-sqlite3';
const [path, held, queued] = process.argv.slice(2);
const db = new Database(path, { readonly: true, fileMustExist: true });
const journal = db.transaction(() => {
  const action = db.prepare("SELECT body FROM work_actions WHERE graph_id=? AND slot='plan:0'").get(held);
  const { input, dispatchId, operationId, status } = JSON.parse(action.body);
  const { attemptId, generation, armed, released, resources } = JSON.parse(
    db.prepare('SELECT body FROM work_dispatches WHERE id=?').get(dispatchId).body,
  );
  const { spec, turnTimeoutMs } = JSON.parse(
    db.prepare('SELECT body FROM work_checkpoints WHERE graph_id=?').get(queued).body,
  );
  const job = db.prepare('SELECT acceptedAt, dueAt, status FROM schedule_jobs WHERE id=?').get(queued);
  const plan = db.prepare("SELECT body FROM work_actions WHERE graph_id=? AND slot='plan:0'").get(queued);
  const intentAt = plan ? JSON.parse(plan.body).input.deadlineAt - turnTimeoutMs : null;
  return {
    held: { deadlineAt: input.deadlineAt, operationId, dispatchId, status,
      attemptId, generation, armed, released, resources },
    queued: { baseRevision: spec.baseRevision, intentAt, ...job },
    owner: db.prepare("SELECT owner, generation FROM ownership WHERE resource='controller'").get(),
  };
})();
console.log(JSON.stringify(journal, null, 2));
db.close();
NODE
```

Check that the two journal captures identify the same held attempt,
operation, deadline and resource set, with `armed: true` and
`released: false`. Confirm that the fixture call count for the held
planning turn stays at one. Capture the second launch while the installed
unit is authoritative by running `node scripts/xvant.mjs daemon serve`
with the same state under `timeout 5s`. Require the competitor to fail
with `LEASE_BUSY` and leave the service owner and generation unchanged.
On reboot, also verify that the old endpoint token presented to the
current listener receives HTTP 401. Keep the old endpoint in its protected
local file and publish the HTTP status only.

```sh
node --input-type=module - "$CASE/old-endpoint.private" "$XVANT_HOME" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { daemonEndpoint } from './scripts/xvant-daemon.mjs';
const old = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const current = daemonEndpoint(process.argv[3]);
assert.ok(old.token !== current.token, 'the service reused its endpoint token');
const response = await fetch(current.origin + '/api/v1/daemon', {
  headers: { origin: current.origin, authorization: 'Bearer ' + old.token },
  signal: AbortSignal.timeout(2000),
});
assert.equal(response.status, 401);
console.log(response.status);
NODE
```

The existing [late-result fixture](https://github.com/Azrkiel/xvant-agent/blob/560c487f7d049dc3dab16b2170fdc4d9ce1c4969/tests/faults/daemon.test.ts#L356)
supplies independent stale-result observation.

If observations disagree with the expected invariants, retain the
diagnostics, record the criterion as partial, and investigate before
retrying. Report the tested/base SHAs, package versions, command outcomes,
systemd invocation identity, boot and suspend evidence, and the assertion
results. Keep reboot, physical suspend, simulation, hosted CI, Windows
and live-provider evidence identifiable. Exclude endpoint tokens, SQLite
contents outside the selected fields, actual user paths, and other secrets
from public evidence.
