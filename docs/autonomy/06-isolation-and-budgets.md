# A06 — Worker isolation and durable resource budgets

Status: planned. Completion prerequisites: A01 and A02. Read [the overall plan](README.md) first.
This can proceed alongside A03–A05; unattended live execution must wait for its outcome.

## Outcome

A worker can exercise only its granted capabilities and resources. Native provider shell/edit/network tools run inside the same enforced boundary as other worker actions. Worktrees and permission prompts alone do not qualify isolation.

Inspect `packages/supervisor`, `packages/policy`, `packages/tools`, `packages/contracts/src/live.ts`, provider controllers, and the native loop limits. Existing native-loop step limits are useful but do not provide aggregate project budgets or contain external runtimes.

## Execution

1. Define an execution-environment contract: identity, allowed mounts, temporary storage, network policy, credential references, resource ceilings, lifecycle, and artifact export.
2. Implement and qualify one Linux isolation backend. Prevent access to other projects, controller state, host sockets, home credentials, and privileged host interfaces. Select a mechanism appropriate to the claimed threat model.
3. Run native provider CLIs inside the boundary. Supply minimal credentials/configuration; verify their required auth flow works without silently opening host access. Declare unsupported provider/profile combinations.
4. Enforce CPU, memory, process count, workspace/disk growth, wall time, and descendant termination. Define cleanup and reconciliation after worker death or service restart.
5. Add transactional project/global budget reservations. Include child tasks, retries, repairs, model calls, and concurrent workers. Reconcile reported usage without releasing uncertain reservations prematurely.
6. Distinguish measured, estimated, partial, and unknown usage. Exact monetary guarantees require enforceable provider limits or conservative maximum reservations; missing telemetry must not become zero cost.
7. Implement quota/auth/network failure classes, bounded backoff, circuit breakers, and explicit unblock rules. Never rotate accounts or enable a paid fallback merely to bypass a block.
8. Inspect exported artifacts and enforce path/symlink/size rules before host integration. A patch may be correct syntactically yet outside task ownership.

## Success criteria

- **A06-C1:** Adversarial workers cannot read/write another workspace, controller database, unrelated secrets, or prohibited network endpoints.
- **A06-C2:** Native provider tools obey the enforced boundary in live qualification for each admitted profile.
- **A06-C3:** Deadline/resource violations terminate the whole owned execution environment and preserve recoverable state.
- **A06-C4:** Concurrent dispatch cannot oversubscribe reserved limits; restarts and child tasks cannot replenish them.
- **A06-C5:** Unknown usage is visible and handled conservatively; claimed financial caps match actual enforcement.
- **A06-C6:** Credential material is absent from persistent prompts, public logs, and exported evidence.
- **A06-C7:** Unsupported isolation/auth routes fail closed with an actionable capability report.

## Validation and latitude

Exercise cross-project access, symlink escape, host-socket access, network egress, fork/process growth, disk exhaustion, stale-worker execution, and concurrent budget claims. Use isolated disposable fixtures. Report exact host/backend/provider versions and the limits of containment; a container label is not proof.

Choose containers, OS isolation, or a stricter sandbox; document tradeoffs. Support only qualified profiles initially. Do not weaken TLS, mount broad host credentials, or declare prompt instructions to be an enforcement boundary.

## Deliverables and handoff

Execution backend, budget ledger, capability/admission matrix, resource/reaping tests, and live boundary evidence. A07 consumes artifact and usage receipts; A10 consumes cleanup, health, and configuration interfaces.
