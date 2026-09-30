# XVANT first executable slice
Date: 2026-09-26
Status: historical first-slice instructions and embedded examples. Phase 1 is now implemented with installed Vitest; see ../phase-01-progress.md and ../evidence/G01.json. The examples below retain the original planning contract.
Parent: 2026-09-26-xvant-implementation-plan.md
Scope: P01.1 and the first behavior slice of P01.2 after G00 establishes a development runtime.

## Goal
Create the smallest original XVANT domain module that refuses to accept work without current verification evidence.

## Architecture
A pure domain module validates transitions and revision-bound check receipts. Tests exercise observable acceptance rules without a model, database, UI, or vendor runtime. Later persistence calls these functions rather than reimplementing the rules.

## Stack
Pinned Node.js from G00, npm, TypeScript, Vitest. Dependency versions are recorded by npm's exact-save flags and package-lock.json after the G00 compatibility decision.

## Files
| File | Responsibility |
| --- | --- |
| package.json | Private npm workspace and verification scripts |
| tsconfig.base.json | Shared strict TypeScript settings |
| packages/core/package.json | XVANT core package metadata |
| packages/core/tsconfig.json | Core source/test type checks |
| packages/core/src/task.ts | Domain contract, state transitions, evidence gate |
| packages/core/src/task.test.ts | Behavior tests for lifecycle and stale/failed evidence |

Do not run git init from C:\Users\jiang. If initializing a repository is authorized during implementation, change to C:\Users\jiang\XVANT and confirm the resolved path first. Preserve this plan bundle.

## Initial behavior diagram

```text
[Worker finishes]
       |
       v
[Task enters verifying]
       |
[Check all required receipts]
       +-- none/missing --> [EVIDENCE_REQUIRED]
       +-- failed -------> [CHECK_FAILED]
       +-- wrong revision> [STALE_EVIDENCE]
       |
     valid
       v
[Ready for acceptance]
       |
[User accepts exact artifact set]
       +-- artifact changed --> [STALE_EVIDENCE]
       +-- checks changed ---> [EVIDENCE_REQUIRED]
       |
       v
[Accepted]
```

This diagram is reviewed as part of the plan. No application files are created by writing this document.

## Step A - Establish the test harness

- [ ] Confirm G00's selected Node/npm works independently of the Hermes installation.
- [ ] Create package.json with the following content.

```json
{
  "name": "xvant",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "vitest run",
    "test:core": "vitest run packages/core/src/task.test.ts",
    "typecheck": "tsc -p packages/core/tsconfig.json --noEmit"
  }
}
```

- [ ] Install only G00-qualified development dependencies. Run from the XVANT root:

```powershell
$xvantBaseline = Get-Content -Raw 'docs/evidence/compatibility.json' | ConvertFrom-Json
$xvantVersions = @($xvantBaseline.dependencies.typescript, $xvantBaseline.dependencies.vitest, $xvantBaseline.dependencies.nodeTypes)
if ($xvantVersions.Where({ [string]::IsNullOrWhiteSpace($_) -or $_ -notmatch '^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$' }).Count -gt 0) { throw 'G00 must provide exact qualified dependency versions' }
$xvantDevPackages = @(
  "typescript@$($xvantVersions[0])",
  "vitest@$($xvantVersions[1])",
  "@types/node@$($xvantVersions[2])"
)
npm install --save-dev --save-exact @xvantDevPackages
```

Precondition: G00 has recorded dependencies.typescript, dependencies.vitest, and dependencies.nodeTypes in compatibility.json. Expected: exit 0, exact dependency versions added, package-lock.json created. Confirm resolved versions match G00's recorded candidates; otherwise stop and update the compatibility decision before proceeding. These are proposed setup commands, not commands already run.

- [ ] Create tsconfig.base.json:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": false,
    "noEmit": true
  }
}
```

- [ ] Create packages/core/package.json:

```json
{
  "name": "@xvant/core",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```

- [ ] Create packages/core/tsconfig.json:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

## Step B - Define the contract and prove the test discovers a failure

- [ ] Create packages/core/src/task.ts with the types and intentionally failing functions below. The stubs exist only for the red stage and must not remain in a passing commit.

```typescript
export type TaskState =
  | "draft"
  | "queued"
  | "running"
  | "verifying"
  | "ready_for_acceptance"
  | "accepted"
  | "blocked"
  | "paused"
  | "needs_rework"
  | "needs_attention"
  | "cancelling"
  | "cancelled";

export type Task = Readonly<{
  id: string;
  state: TaskState;
  revision: number;
  treeHash: string;
  artifactSetHash: string;
  requiredCheckIds: readonly string[];
}>;

export type CheckReceipt = Readonly<{
  checkId: string;
  taskRevision: number;
  treeHash: string;
  artifactSetHash: string;
  passed: boolean;
}>;

export type Evidence = Readonly<{
  taskRevision: number;
  treeHash: string;
  artifactSetHash: string;
  receipts: readonly CheckReceipt[];
}>;

export class DomainError extends Error {
  constructor(
    public readonly code:
      | "INVALID_TRANSITION"
      | "EVIDENCE_REQUIRED"
      | "STALE_EVIDENCE"
      | "CHECK_FAILED",
  ) {
    super(code);
    this.name = "DomainError";
  }
}

export function transition(
  task: Task,
  next: TaskState,
  evidence?: Evidence,
): Task {
  throw new Error("RED_STAGE");
}
```

- [ ] Create packages/core/src/task.test.ts:

```typescript
import { describe, expect, it } from "vitest";
import {
  transition,
  type Evidence,
  type Task,
  type TaskState,
} from "./task.js";

function makeTask(state: TaskState): Task {
  return {
    id: "task-1",
    state,
    revision: 7,
    treeHash: "tree-a",
    artifactSetHash: "artifacts-a",
    requiredCheckIds: ["acceptance", "review"],
  };
}

function validEvidence(task: Task): Evidence {
  return {
    taskRevision: task.revision,
    treeHash: task.treeHash,
    artifactSetHash: task.artifactSetHash,
    receipts: task.requiredCheckIds.map((checkId) => ({
      checkId,
      taskRevision: task.revision,
      treeHash: task.treeHash,
      artifactSetHash: task.artifactSetHash,
      passed: true,
    })),
  };
}

describe("task transitions", () => {
  it("queues a draft without mutating the original", () => {
    const task = makeTask("draft");
    const next = transition(task, "queued");
    expect(next.state).toBe("queued");
    expect(task.state).toBe("draft");
    expect(next).not.toBe(task);
  });

  it("does not accept directly from running", () => {
    expect(() => transition(makeTask("running"), "accepted"))
      .toThrow("INVALID_TRANSITION");
  });

  it("requires evidence before ready_for_acceptance", () => {
    expect(() => transition(makeTask("verifying"), "ready_for_acceptance"))
      .toThrow("EVIDENCE_REQUIRED");
  });

  it("rejects an empty required-check plan", () => {
    const task = { ...makeTask("verifying"), requiredCheckIds: [] };
    expect(() =>
      transition(task, "ready_for_acceptance", validEvidence(task)),
    ).toThrow("EVIDENCE_REQUIRED");
  });

  it("rejects missing required receipts", () => {
    const task = makeTask("verifying");
    const evidence = { ...validEvidence(task), receipts: [] };
    expect(() => transition(task, "ready_for_acceptance", evidence))
      .toThrow("EVIDENCE_REQUIRED");
  });

  it("rejects stale top-level evidence", () => {
    const task = makeTask("verifying");
    const evidence = { ...validEvidence(task), treeHash: "old-tree" };
    expect(() => transition(task, "ready_for_acceptance", evidence))
      .toThrow("STALE_EVIDENCE");
  });

  it("rejects a stale required receipt", () => {
    const task = makeTask("verifying");
    const evidence = validEvidence(task);
    const receipts = evidence.receipts.map((receipt) => ({
      ...receipt,
      taskRevision: task.revision - 1,
    }));
    expect(() =>
      transition(task, "ready_for_acceptance", { ...evidence, receipts }),
    ).toThrow("STALE_EVIDENCE");
  });

  it("rejects failed checks even when the output claims success", () => {
    const task = makeTask("verifying");
    const evidence = validEvidence(task);
    const receipts = evidence.receipts.map((receipt) => ({
      ...receipt,
      passed: receipt.checkId !== "review",
    }));
    expect(() =>
      transition(task, "ready_for_acceptance", { ...evidence, receipts }),
    ).toThrow("CHECK_FAILED");
  });

  it("rejects duplicate receipts for a required check", () => {
    const task = makeTask("verifying");
    const evidence = validEvidence(task);
    expect(() =>
      transition(task, "ready_for_acceptance", {
        ...evidence,
        receipts: [...evidence.receipts, ...evidence.receipts],
      }),
    ).toThrow("EVIDENCE_REQUIRED");
  });

  it("becomes ready only with all current passing receipts", () => {
    const task = makeTask("verifying");
    const next = transition(task, "ready_for_acceptance", validEvidence(task));
    expect(next.state).toBe("ready_for_acceptance");
  });

  it("rechecks evidence when accepting", () => {
    const task = makeTask("ready_for_acceptance");
    const evidence = { ...validEvidence(task), artifactSetHash: "old-artifacts" };
    expect(() => transition(task, "accepted", evidence))
      .toThrow("STALE_EVIDENCE");
  });

  it("accepts current verified artifacts", () => {
    const task = makeTask("ready_for_acceptance");
    expect(transition(task, "accepted", validEvidence(task)).state)
      .toBe("accepted");
  });

  it("does not reopen an accepted task through a transition", () => {
    expect(() => transition(makeTask("accepted"), "queued"))
      .toThrow("INVALID_TRANSITION");
  });

  it("does not reopen a cancelled task through a transition", () => {
    expect(() => transition(makeTask("cancelled"), "queued"))
      .toThrow("INVALID_TRANSITION");
  });

  it("allows an unresolved running attempt to need attention", () => {
    expect(transition(makeTask("running"), "needs_attention").state)
      .toBe("needs_attention");
  });
});
```

- [ ] Run:

```powershell
npm run test:core
```

Expected red stage: exit nonzero, exactly 15 tests discovered, failures refer to RED_STAGE rather than import errors. If no tests run or the environment fails to import, fix the harness before treating the run as meaningful evidence.

## Step C - Implement the minimal domain behavior

- [ ] Keep the types and DomainError. Replace the transition stub with the following implementation and supporting constants/functions in packages/core/src/task.ts.

```typescript
const transitions: Record<TaskState, readonly TaskState[]> = {
  draft: ["queued", "cancelling"],
  queued: ["running", "blocked", "paused", "cancelling"],
  running: ["verifying", "paused", "needs_attention", "cancelling"],
  verifying: ["ready_for_acceptance", "needs_rework", "needs_attention", "cancelling"],
  ready_for_acceptance: ["accepted", "needs_rework", "cancelling"],
  accepted: [],
  blocked: ["queued", "cancelling"],
  paused: ["queued", "cancelling"],
  needs_rework: ["queued", "cancelling"],
  needs_attention: ["queued", "verifying", "cancelling"],
  cancelling: ["cancelled", "needs_attention"],
  cancelled: [],
};

function requireEvidence(task: Task, evidence?: Evidence): void {
  if (!evidence || task.requiredCheckIds.length === 0) {
    throw new DomainError("EVIDENCE_REQUIRED");
  }

  if (
    evidence.taskRevision !== task.revision ||
    evidence.treeHash !== task.treeHash ||
    evidence.artifactSetHash !== task.artifactSetHash
  ) {
    throw new DomainError("STALE_EVIDENCE");
  }

  if (new Set(task.requiredCheckIds).size !== task.requiredCheckIds.length) {
    throw new DomainError("EVIDENCE_REQUIRED");
  }

  for (const checkId of task.requiredCheckIds) {
    const matches = evidence.receipts.filter((receipt) => receipt.checkId === checkId);
    const receipt = matches[0];

    if (matches.length !== 1 || !receipt) {
      throw new DomainError("EVIDENCE_REQUIRED");
    }

    if (
      receipt.taskRevision !== task.revision ||
      receipt.treeHash !== task.treeHash ||
      receipt.artifactSetHash !== task.artifactSetHash
    ) {
      throw new DomainError("STALE_EVIDENCE");
    }

    if (!receipt.passed) {
      throw new DomainError("CHECK_FAILED");
    }
  }
}

export function transition(
  task: Task,
  next: TaskState,
  evidence?: Evidence,
): Task {
  if (!transitions[task.state].includes(next)) {
    throw new DomainError("INVALID_TRANSITION");
  }

  if (next === "ready_for_acceptance" || next === "accepted") {
    requireEvidence(task, evidence);
  }

  return { ...task, state: next };
}
```

Scope of this slice:
- revision represents the verified work specification/revision here; storage command concurrency later uses a separate rowVersion.
- The domain function validates evidence supplied by a trusted verification service. It does not authenticate receipts.
- In Phase 2, accept commands load trusted checks from storage. Browser clients and worker messages cannot invent passing receipts.
- Moving needs_attention to queued requires reconciliation in the application service. The pure transition table alone is not permission to resend an uncertain operation.
- Paused is only reached after an adapter checkpoint acknowledgement. The application service tracks the intermediate pause request.
- Supplement exhaustive transition and property tests in P01.2 before claiming the whole state machine is verified.

- [ ] Run:

```powershell
npm run test:core
npm run typecheck
```

Expected: both exit 0; exactly 15 core tests pass; no TypeScript errors.
- [ ] Review acceptance bypasses, stale hashes, duplicate checks, and mutability.
- [ ] Inspect the staged diff if Git has been initialized; exclude node_modules, credentials, generated logs, and local state.
- [ ] Record red/green evidence and commit the coherent slice when Git implementation is authorized.

## Step D - Extend the slice in dependency order

The following are subsequent work items from the main plan, not part of the 15-test starter:
1. Runtime schemas: reject malformed/empty IDs, bad revisions, duplicate criteria, and oversized objectives at ingestion.
2. Separate workRevision and rowVersion throughout contracts; changing criteria invalidates verification.
3. Exhaustive legal/illegal transition tests plus graph cycle/depth properties.
4. A simulated worker emits normalized events with task/attempt IDs.
5. A minimal controller runs the offline lifecycle and writes gate evidence.
6. SQLite persistence and dispatch reconciliation follow only after G01.

Acceptance for implementation of this starter: one meaningful invariant is protected with a recorded Vitest red/green cycle and passing typecheck. It is not a completed agent harness, release gate G01, or a demonstrated provider integration.

Planning audit: node docs/plans/audit-plan.mjs transforms the embedded TypeScript and runs the 15 examples through a small Node assertion harness. The audit observed 15 intended failures in red and 15 passes in green. It does not replace Vitest discovery, compiler type checking, dependency qualification, or application verification.

