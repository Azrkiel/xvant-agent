import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  type CompletionObservation,
  type ProjectContract,
  type ProjectPolicy,
  type ProjectTask,
} from '../../../packages/contracts/src/project.ts';
import type { ProjectBacklog } from '../../../packages/contracts/src/project-backlog.ts';
import {
  completionSubject,
  decideCompletion,
  reportRevision,
} from '../../../packages/policy/src/project.ts';
import {
  ArtifactStore,
  backupSnapshot,
  restoreSnapshot,
} from '../../../packages/storage/src/artifacts.ts';
import { SCHEMA_VERSION, Store } from '../../../packages/storage/src/store.ts';
import { startApp } from './app.ts';
import { Orchestrator, type RootState } from './orchestrator.ts';

const cliPath = fileURLToPath(
  new URL('../../../scripts/xvant.mjs', import.meta.url),
);
const base = 'b'.repeat(40);
const candidate = 'c'.repeat(40);
const sourcePath = 'tests/order.cjs';
const requirementIds = ['order'];
let root: string;
let store: Store;

const open = () => new Store(join(root, 'state.sqlite'), { owner: 'fixture' });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-contracts-')));
  store = open();
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function records(repository = root) {
  const project: ProjectContract = {
    schemaVersion: 1,
    id: 'flaky',
    version: 1,
    ownerIntent: {
      actorId: 'owner',
      objective: 'Stabilize the order-sensitive test',
    },
    requirements: [
      { id: 'order', description: 'Explain or fix the order dependency' },
    ],
    exclusions: ['No production behavior changes'],
    scope: { repository, paths: ['tests'], excludedPaths: ['tests/private'] },
  };
  const policy: ProjectPolicy = {
    schemaVersion: 1,
    projectId: project.id,
    projectVersion: 1,
    version: 1,
    ownerId: 'owner',
    authority: {
      scope: project.scope,
      actions: ['read', 'edit', 'report', 'verify'],
      providers: ['native-local', 'codex'],
      budget: { attempts: 2, wallTimeMs: 10000, tokens: 2000, costMicros: 0 },
      delivery: { localCandidate: true, createPr: true, merge: true },
    },
    verifier: {
      id: 'fixture',
      configHash: 'a'.repeat(64),
      checks: [{ id: 'verify-order', requirementIds }],
    },
    review: { required: true, reviewers: ['reviewer'] },
    automaticAcceptance: true,
    escalation: { onBlock: 'owner', allowManualException: true },
  };
  const task: Extract<ProjectTask, { type: 'ship' }> = {
    schemaVersion: 1,
    id: 'ship',
    projectId: project.id,
    projectVersion: 1,
    policyVersion: 1,
    type: 'ship',
    baseRevision: base,
    ownerIntent: { actorId: 'owner', objective: 'Fix it' },
    managerBrief: {
      actorId: 'manager',
      description: 'Reset the fixture state before each assertion',
    },
    requirementIds,
    authority: {
      ...policy.authority,
      scope: { repository, paths: [sourcePath], excludedPaths: [] },
      actions: ['read', 'edit', 'verify'],
      providers: ['native-local'],
      delivery: { localCandidate: true, createPr: false, merge: false },
    },
  };
  return { project, policy, task };
}

type Records = ReturnType<typeof records>;
const ownerCommands = ({ project, policy }: Records) => [
  { kind: 'project', commandId: 'create-project', expectedVersion: 0, project },
  { kind: 'policy', commandId: 'create-policy', expectedVersion: 0, policy },
];
const createTask = (task: ProjectTask) => ({
  kind: 'task',
  commandId: 'create-' + task.id,
  task,
});
function setup(value = records()) {
  for (const cmd of [...ownerCommands(value), createTask(value.task)])
    store.contracts.apply(cmd);
  return value;
}

function backlogPlan(): ProjectBacklog {
  return {
    schemaVersion: 1,
    projectId: 'flaky',
    projectVersion: 1,
    policyVersion: 1,
    revision: 1,
    reason: 'Investigate before repairing the order dependency',
    milestones: [
      {
        id: 'investigate',
        title: 'Investigate',
        priority: 2,
        dependsOn: [],
        requirementIds,
        reason: 'Find the shared state',
      },
      {
        id: 'repair',
        title: 'Repair',
        priority: 1,
        dependsOn: ['investigate'],
        requirementIds,
        reason: 'Apply the observed correction',
      },
      {
        id: 'verify',
        title: 'Verify',
        priority: 1,
        dependsOn: ['repair', 'control'],
        requirementIds,
        reason: 'Compare both test orders',
      },
      {
        id: 'control',
        title: 'Prepare a control',
        priority: 0,
        dependsOn: [],
        requirementIds,
        reason: 'Keep the original failure reproducible',
      },
    ],
    notes: [
      {
        id: 'fixture-only',
        kind: 'decision',
        summary: 'Use disposable test files',
      },
      {
        id: 'setup',
        kind: 'question',
        summary: 'Is test isolation configurable?',
        nextAction: 'Inspect test setup',
      },
      {
        id: 'missing-env',
        kind: 'blocker',
        summary: 'Original environment missing',
        milestoneId: 'investigate',
        nextAction: 'Find the frozen fixture',
      },
    ],
  };
}

const saveBacklog = (backlog: ProjectBacklog, commandId = 'save-backlog') => ({
  kind: 'backlog',
  commandId,
  expectedRevision: backlog.revision - 1,
  backlog,
});

describe('project backlog', () => {
  it('upgrades schema 9 and preserves backlog rows through a verified snapshot', async () => {
    const { project, policy } = setup();
    store.close();
    const previous = new Database(join(root, 'state.sqlite'));
    try {
      previous.exec(
        'DROP TABLE github_issue_deliveries; DROP TABLE contract_backlogs; PRAGMA user_version=9;',
      );
    } finally {
      previous.close();
    }
    store = open();
    expect(store.schemaVersion()).toBe(11);
    expect(store.contracts.getProject(project.id)).toEqual({ project, policy });
    const backlog = backlogPlan();
    store.contracts.apply(saveBacklog(backlog));
    const backup = join(root, 'backlog-backup');
    const restore = join(root, 'backlog-restore');
    await backupSnapshot(
      store,
      new ArtifactStore(join(root, 'objects')),
      backup,
    );
    await restoreSnapshot(backup, restore);
    const restored = new Database(join(restore, 'state.sqlite'), {
      readonly: true,
    });
    try {
      const rows = restored
        .prepare('SELECT body FROM contract_backlogs')
        .all() as { body: string }[];
      expect(rows.map(({ body }) => JSON.parse(body))).toEqual([backlog]);
      expect(restored.pragma('foreign_key_check')).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it('recovers immutable plans, rationale, notes and authorized ceilings after reopening the host', () => {
    const { project, policy } = setup();
    expect(store.contracts.getBacklog(project.id).status).toBe('unplanned');
    const original = backlogPlan();
    expect(store.contracts.apply(saveBacklog(original))).toEqual(original);
    const next = {
      ...original,
      revision: 2,
      reason: 'Record the frozen fixture',
      notes: [],
    };
    expect(store.contracts.apply(saveBacklog(next, 'frozen-fixture'))).toEqual(
      next,
    );
    store.close();
    store = open();
    expect(store.contracts.getBacklog(project.id)).toEqual({
      projectId: project.id,
      ownerIntent: project.ownerIntent,
      requirements: project.requirements,
      projectVersion: project.version,
      policyVersion: policy.version,
      budgetCeilings: policy.authority.budget,
      status: 'current',
      backlog: next,
    });
    expect(store.contracts.getBacklog(project.id, 1)).toMatchObject({
      backlog: original,
      status: 'superseded',
    });
    expect(() => store.contracts.getBacklog(project.id, 3)).toThrow(
      'NOT_FOUND',
    );
    expect(store.contracts.apply(saveBacklog(original))).toEqual(original);
    expect(() =>
      store.contracts.apply(saveBacklog({ ...original, reason: 'changed' })),
    ).toThrow('CONFLICT');
    expect(() =>
      store.contracts.apply(saveBacklog(next, 'stale-revision')),
    ).toThrow('CONFLICT');
  });

  it('denies unknown requirements, invalid dependencies, and stale authority', () => {
    const { project, policy } = setup();
    const unknown = backlogPlan();
    unknown.milestones[0]!.requirementIds = ['unapproved'];
    expect(() => store.contracts.apply(saveBacklog(unknown))).toThrow(
      'POLICY_DENIED',
    );
    const cycle = backlogPlan();
    cycle.milestones[0]!.dependsOn = ['verify'];
    expect(() => store.contracts.apply(saveBacklog(cycle))).toThrow(
      'GRAPH_INVALID',
    );
    const badNote = backlogPlan();
    badNote.notes[0]!.milestoneId = 'missing';
    expect(() => store.contracts.apply(saveBacklog(badNote))).toThrow(
      'CONFLICT',
    );
    const original = backlogPlan();
    store.contracts.apply(saveBacklog(original));
    store.contracts.apply({
      kind: 'project',
      commandId: 'new-scope',
      expectedVersion: 1,
      project: { ...project, version: 2 },
    });
    expect(store.contracts.getBacklog(project.id)).toMatchObject({
      status: 'stale',
      projectVersion: 2,
      budgetCeilings: null,
      backlog: original,
    });
    expect(() =>
      store.contracts.apply(
        saveBacklog(
          {
            ...original,
            revision: 2,
            projectVersion: 2,
          },
          'pending-policy',
        ),
      ),
    ).toThrow('POLICY_DENIED');
    store.contracts.apply({
      kind: 'policy',
      commandId: 'new-policy',
      expectedVersion: 1,
      policy: { ...policy, projectVersion: 2, version: 2 },
    });
    const next = {
      ...original,
      revision: 2,
      projectVersion: 2,
      policyVersion: 2,
    };
    expect(
      store.contracts.apply(saveBacklog(next, 'with-current-policy')),
    ).toEqual(next);
  });
});

function valid(
  { task, policy }: Records,
  attemptId = 'attempt',
  revision = candidate,
) {
  const subject = completionSubject(task, policy, attemptId, revision);
  return {
    attemptId,
    outcome: {
      status: 'candidate',
      repository: task.authority.scope.repository,
      baseRevision: task.baseRevision,
      revision,
      changedPaths: [sourcePath],
      producers: ['worker'],
      provider: 'native-local' as const,
    },
    verification: {
      subject: structuredClone(subject),
      checks: [{ id: 'verify-order', status: 'passed' }],
    },
    review: {
      subject: structuredClone(subject),
      reviewerId: 'reviewer',
      status: 'approved',
    },
  } satisfies CompletionObservation;
}

const accept = (
  taskId: string,
  revision: string,
  attemptId = 'attempt',
  expectedVersion = 2,
) => ({
  kind: 'accept',
  commandId: 'accept-' + taskId,
  taskId,
  acceptance: {
    expectedVersion,
    attemptId,
    revision,
    mode: { kind: 'automatic' },
  },
});

describe('A01 admission', () => {
  it('persists valid versioned records with separately attributable owner and manager intent', () => {
    const values = setup();
    expect(store.contracts.getProject(values.project.id)).toEqual({
      project: values.project,
      policy: values.policy,
    });
    expect(store.contracts.getTask(values.task.id).record).toMatchObject({
      task: values.task,
      rowVersion: 1,
      acceptance: null,
    });
    const child: ProjectTask = {
      ...values.task,
      id: 'child',
      parentTaskId: values.task.id,
      authority: {
        ...values.task.authority,
        budget: { ...values.task.authority.budget, attempts: 1 },
      },
    };
    expect(store.contracts.apply(createTask(child))).toMatchObject({
      task: child,
    });
  });

  it('rejects unsupported versions for project, policy and task', () => {
    const { project, policy, task } = records();
    for (const command of [
      {
        ...ownerCommands({ project, policy, task })[0],
        project: { ...project, schemaVersion: 2 },
      },
      {
        ...ownerCommands({ project, policy, task })[1],
        policy: { ...policy, schemaVersion: 2 },
      },
      createTask({ ...task, schemaVersion: 2 } as unknown as ProjectTask),
    ])
      expect(() => store.contracts.apply(command)).toThrow('Invalid input');
  });

  it.each([
    [
      'repository',
      (t: ProjectTask) => {
        t.authority.scope.repository += '-other';
      },
    ],
    [
      'path',
      (t: ProjectTask) => {
        t.authority.scope.paths = ['tests'];
      },
    ],
    [
      'provider',
      (t: ProjectTask) => {
        t.authority.providers.push('codex');
      },
    ],
    [
      'action',
      (t: ProjectTask) => {
        t.authority.actions.push('report');
      },
    ],
    [
      'budget',
      (t: ProjectTask) => {
        t.authority.budget.attempts += 1;
      },
    ],
    [
      'publication',
      (t: ProjectTask) => {
        t.authority.delivery.createPr = true;
      },
    ],
    [
      'merge',
      (t: ProjectTask) => {
        t.authority.delivery.merge = true;
      },
    ],
    [
      'base',
      (t: ProjectTask) => {
        t.baseRevision = candidate;
      },
    ],
  ])('rejects broader or changed child %s', (_dimension, modify) => {
    const { task } = setup();
    const child = {
      ...structuredClone(task),
      id: 'child',
      parentTaskId: task.id,
    };
    modify(child);
    expect(() => store.contracts.apply(createTask(child))).toThrow(
      'POLICY_DENIED',
    );
  });

  it('denies contradictory grants, exclusions lost by narrowing and unrecognized requirements', () => {
    const { task, policy, project } = setup();
    const badTasks = [
      { ...task, id: 'scout', type: 'scout' as const },
      { ...task, requirementIds: ['unowned'] },
      { ...task, ownerIntent: { ...task.ownerIntent, actorId: 'manager' } },
      {
        ...task,
        authority: {
          ...policy.authority,
          scope: { ...project.scope, excludedPaths: [] },
        },
      },
      {
        ...task,
        authority: {
          ...task.authority,
          delivery: { localCandidate: false, createPr: true, merge: false },
        },
      },
    ];
    for (const [index, bad] of badTasks.entries())
      expect(() =>
        store.contracts.apply(createTask({ ...bad, id: 'bad-' + index })),
      ).toThrow('POLICY_DENIED');
  });
});

describe('A01 completion truth table', () => {
  it.each<
    [
      string,
      (value: ReturnType<typeof valid>) => CompletionObservation,
      string,
      boolean,
    ]
  >([
    [
      'empty checks',
      (value) => ({
        ...value,
        verification: { ...value.verification, checks: [] },
      }),
      'checks_missing',
      true,
    ],
    [
      'stale revision',
      (value) => {
        value.verification.subject.revision = base;
        return value;
      },
      'verification_stale',
      true,
    ],
    [
      'changed verifier',
      (value) => {
        value.verification.subject.verifierConfigHash = 'd'.repeat(64);
        return value;
      },
      'verification_stale',
      true,
    ],
    [
      'stale requirements',
      (value) => {
        value.verification.subject.requirementIds = ['old'];
        return value;
      },
      'verification_stale',
      true,
    ],
    [
      'missing review',
      (value) => ({ ...value, review: undefined }),
      'review_missing',
      true,
    ],
    [
      'rejected review',
      (value) => ({
        ...value,
        review: { ...value.review, status: 'rejected' },
      }),
      'review_rejected',
      true,
    ],
    [
      'stale review',
      (value) => {
        value.review.subject.attemptId = 'earlier';
        return value;
      },
      'review_stale',
      true,
    ],
    [
      'self review',
      (value) => {
        value.outcome.producers = ['reviewer'];
        return value;
      },
      'reviewer_ineligible',
      true,
    ],
    [
      'unknown worker outcome',
      (value) => ({ ...value, outcome: { status: 'unknown' } }),
      'unknown',
      false,
    ],
    [
      'unknown check outcome',
      (value) => ({
        ...value,
        verification: {
          ...value.verification,
          checks: [{ id: 'verify-order', status: 'unknown' }],
        },
      }),
      'checks_not_passed',
      true,
    ],
    [
      'ungranted provider',
      (value) => ({
        ...value,
        outcome: { ...value.outcome, provider: 'codex' },
      }),
      'provider_violation',
      false,
    ],
    [
      'changed paths',
      (value) => {
        value.outcome.changedPaths = ['outside.cjs'];
        return value;
      },
      'scope_violation',
      false,
    ],
  ])(
    'blocks %s with explicit review readiness',
    (_name, change, blocker, ready) => {
      const value = records();
      const next = change(valid(value));
      expect(
        decideCompletion(value.project, value.policy, value.task, next),
      ).toMatchObject({
        blockers: [blocker],
        readyForHumanReview: ready,
        eligibleForAutomaticAcceptance: false,
      });
    },
  );

  it('requires coverage of every assigned requirement and accepts the fully bound candidate', () => {
    const value = records();
    const observation = valid(value);
    expect(
      decideCompletion(value.project, value.policy, value.task, observation),
    ).toMatchObject({
      subject: observation.verification.subject,
      readyForHumanReview: true,
      eligibleForAutomaticAcceptance: true,
      checks: 'passed',
      review: 'approved',
      blockers: [],
    });
    value.policy.verifier.checks = [];
    expect(
      decideCompletion(value.project, value.policy, value.task, observation)
        .blockers,
    ).toEqual(['checks_missing']);
  });
});

describe('A01 durable decisions', () => {
  it('replays the same acceptance and rejects stale or conflicting commands without another decision', () => {
    const value = setup();
    const observation = valid(value);
    store.contracts.recordObservation('observe', 'ship', 1, observation);
    const command = accept('ship', candidate);
    const accepted = store.contracts.apply(command);
    expect(accepted).toMatchObject({
      rowVersion: 3,
      acceptance: { accepted: true },
    });
    store.close();
    store = open();
    expect(store.contracts.apply(command)).toEqual(accepted);
    expect(() =>
      store.contracts.apply({ ...command, commandId: 'again' }),
    ).toThrow('CONFLICT');
    expect(() => store.contracts.apply(accept('ship', base))).toThrow(
      'CONFLICT',
    );
    expect(store.contracts.getTask('ship').record).toEqual(accepted);
  });

  it('keeps a denied decision in the journal and prevents stale writes over fresher evidence', () => {
    const value = setup();
    const observation = valid(value);
    store.contracts.recordObservation('observe', 'ship', 1, {
      ...observation,
      review: undefined,
    });
    const command = accept('ship', candidate);
    const denied = store.contracts.apply(command);
    expect(denied).toMatchObject({
      rowVersion: 3,
      acceptance: { accepted: false },
    });
    const fresh = valid(value, 'fresh');
    expect(() =>
      store.contracts.recordObservation('too-old', 'ship', 2, fresh),
    ).toThrow('CONFLICT');
    expect(() =>
      store.contracts.recordObservation(
        'reuse-attempt',
        'ship',
        3,
        observation,
      ),
    ).toThrow('DUPLICATE_IDENTITY');
    store.contracts.recordObservation('observe-fresh', 'ship', 3, fresh);
    expect(store.contracts.apply(command)).toEqual(denied);
    expect(store.contracts.getTask('ship').record).toMatchObject({
      rowVersion: 4,
      acceptance: null,
    });
    expect(
      store.contracts.apply({
        ...accept('ship', candidate, 'fresh', 4),
        commandId: 'new-decision',
      }),
    ).toMatchObject({ rowVersion: 5, acceptance: { accepted: true } });
  });

  it('requires an explicit exact-result owner exception and records what was waived', () => {
    const value = setup();
    store.contracts.recordObservation('observe', 'ship', 1, {
      ...valid(value),
      review: undefined,
    });
    const command = accept('ship', candidate);
    const exception = {
      kind: 'exception',
      actorId: 'owner',
      reason: 'Owner reviewed the result directly',
    };
    expect(() =>
      store.contracts.apply({
        ...command,
        acceptance: {
          ...command.acceptance,
          mode: { ...exception, actorId: 'worker' },
        },
      }),
    ).toThrow('POLICY_DENIED');
    expect(() =>
      store.contracts.apply({
        ...command,
        acceptance: { ...command.acceptance, revision: base, mode: exception },
      }),
    ).toThrow('CONFLICT');
    expect(
      store.contracts.apply({
        ...command,
        acceptance: { ...command.acceptance, mode: exception },
      }),
    ).toMatchObject({
      acceptance: {
        accepted: true,
        request: { mode: exception, revision: candidate },
        decision: {
          blockers: ['review_missing'],
          eligibleForAutomaticAcceptance: false,
        },
      },
    });
  });

  it('preserves a manual acceptance route when automatic acceptance is disabled', () => {
    const value = records();
    value.policy.automaticAcceptance = false;
    setup(value);
    store.contracts.recordObservation('observe', 'ship', 1, valid(value));
    const command = accept('ship', candidate);
    expect(
      store.contracts.apply({
        ...command,
        acceptance: {
          ...command.acceptance,
          mode: { kind: 'manual', actorId: 'owner' },
        },
      }),
    ).toMatchObject({
      acceptance: {
        accepted: true,
        decision: { blockers: ['automatic_acceptance_disabled'] },
      },
    });
  });

  it('cannot record new attempts past the admitted budget', () => {
    const value = records();
    value.task.authority.budget.attempts = 1;
    setup(value);
    store.contracts.recordObservation('observe', 'ship', 1, {
      attemptId: 'attempt',
      outcome: { status: 'failed' },
    });
    expect(() =>
      store.contracts.recordObservation(
        'next',
        'ship',
        2,
        valid(value, 'new-attempt'),
      ),
    ).toThrow('POLICY_DENIED');
    expect(store.contracts.getTask('ship').record).toMatchObject({
      rowVersion: 2,
      attemptsRecorded: 1,
      observation: { outcome: { status: 'failed' } },
    });
  });

  it('retains unknown outcomes and prevents a new attempt from obscuring them', () => {
    setup();
    store.contracts.recordObservation('observe', 'ship', 1, {
      attemptId: 'attempt',
      outcome: { status: 'unknown' },
    });
    expect(store.contracts.getTask('ship').decision.blockers).toEqual([
      'unknown',
    ]);
    expect(() => store.contracts.apply(accept('ship', candidate))).toThrow(
      'CONFLICT',
    );
    expect(() =>
      store.contracts.recordObservation(
        'again',
        'ship',
        2,
        valid(records(), 'fresh'),
      ),
    ).toThrow('CONFLICT');
  });

  it.each(['scope', 'verifier', 'policy'])(
    'invalidates outstanding authorization after changing %s',
    (change) => {
      const value = setup();
      store.contracts.recordObservation('observe', 'ship', 1, valid(value));
      expect(
        store.contracts.getTask('ship').decision.eligibleForAutomaticAcceptance,
      ).toBe(true);
      const { project, policy } = value;
      if (change === 'scope') {
        store.contracts.apply({
          kind: 'project',
          commandId: 'revise-scope',
          expectedVersion: 1,
          project: {
            ...project,
            version: 2,
            scope: { ...project.scope, paths: ['docs'], excludedPaths: [] },
          },
        });
      } else {
        store.contracts.apply({
          kind: 'policy',
          commandId: 'revise-policy',
          expectedVersion: 1,
          policy: {
            ...policy,
            version: 2,
            automaticAcceptance: change !== 'policy',
            verifier:
              change === 'verifier'
                ? { ...policy.verifier, configHash: 'f'.repeat(64) }
                : policy.verifier,
          },
        });
      }
      expect(store.contracts.getTask('ship')).toMatchObject({
        decision: { blockers: ['authorization_stale'] },
        delivery: { localCandidate: false, createPr: false, merge: false },
      });
      expect(store.contracts.apply(accept('ship', candidate))).toMatchObject({
        acceptance: {
          accepted: false,
          decision: { blockers: ['authorization_stale'] },
        },
      });
      expect(() =>
        store.contracts.apply(createTask({ ...value.task, id: 'stale-task' })),
      ).toThrow('POLICY_DENIED');
    },
  );
});

function repoFixture() {
  const repository = join(root, 'repo');
  mkdirSync(join(repository, 'tests'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(
    join(repository, sourcePath),
    `
const assert = require('node:assert/strict');
let pending = false;
if (process.argv[2] === 'reverse') pending = true;
assert.equal(pending, false);
`,
  );
  git('add', '.');
  git('commit', '-qm', 'Add order-sensitive test');
  return { repository, git, baseRevision: git('rev-parse', 'HEAD') };
}

const cli = (...args: string[]) =>
  execFileSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, XVANT_HOME: root },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

it('A01 offline fixture reports on the flaky test and then ships only with separate authority', async () => {
  const { repository, git, baseRevision } = repoFixture();
  const runTest = (order: string) =>
    spawnSync(process.execPath, [sourcePath, order], {
      cwd: repository,
      encoding: 'utf8',
    });
  expect(runTest('normal').status).toBe(0);
  expect(runTest('reverse')).toMatchObject({
    status: 1,
    stderr: expect.stringContaining('AssertionError'),
  });
  const fixture = records(repository);
  const { policy } = fixture;
  const scout: ProjectTask = {
    ...fixture.task,
    id: 'scout',
    baseRevision,
    type: 'scout',
    ownerIntent: { actorId: 'owner', objective: 'Investigate the flaky test' },
    managerBrief: {
      actorId: 'manager',
      description: 'Compare the two test orders and cite the source',
    },
    authority: {
      ...fixture.task.authority,
      actions: ['read', 'report', 'verify'],
      delivery: { localCandidate: false, createPr: false, merge: false },
    },
  };
  const report = {
    summary:
      'Reverse order leaves shared pending state set before the assertion.',
    sources: [
      {
        path: sourcePath,
        revision: baseRevision,
        observation: 'Only reverse order sets pending.',
      },
    ],
  };
  const revision = reportRevision(repository, baseRevision, report);
  const ship = {
    ...fixture.task,
    baseRevision,
    sourceReport: { taskId: scout.id, revision },
    authority: {
      ...fixture.task.authority,
      delivery: { localCandidate: true, createPr: true, merge: false },
    },
  };
  store.close();
  const app = await startApp({
    home: root,
    discover: (runtimeKind) => ({
      runtimeKind,
      status: 'unavailable',
      executable: null,
      version: null,
      expectedVersion: '',
      candidates: 0,
    }),
  });
  try {
    const path = app.origin + '/api/v1/contracts';
    const response = await fetch(app.origin + '/api/v1/session', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + app.bootstrapToken,
        origin: app.origin,
      },
    });
    expect(response.ok).toBe(true);
    const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    const { csrfToken } = (await response.json()) as { csrfToken: string };
    const post = (value: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: {
          cookie,
          origin: app.origin,
          'x-csrf-token': csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify(value),
      });
    const getTask = async (id: string) => {
      const result = await fetch(path + '/tasks/' + id, {
        headers: { cookie },
      });
      expect(result.status).toBe(200);
      return result.json();
    };
    for (const command of [...ownerCommands(fixture), createTask(scout)])
      expect((await post(command)).status).toBe(202);
    const backlogPath = path + '/projects/' + fixture.project.id + '/backlog';
    expect((await fetch(backlogPath)).status).toBe(401);
    expect((await post(saveBacklog(backlogPlan()))).status).toBe(202);
    const backlogView = await fetch(backlogPath, { headers: { cookie } });
    expect(backlogView.status).toBe(200);
    expect(await backlogView.json()).toMatchObject({
      status: 'current',
      backlog: backlogPlan(),
    });
    expect((await post(createTask(ship))).status).toBe(403);
    expect(
      (await post({ kind: 'observe', attemptId: 'scout-attempt' })).status,
    ).toBe(400);
    const reportSubject = completionSubject(
      scout,
      policy,
      'scout-attempt',
      revision,
    );
    const observations = {
      commandId: 'observe-report',
      taskId: scout.id,
      expectedVersion: 1,
      attemptId: 'scout-attempt',
      outcome: {
        status: 'report' as const,
        report,
        producers: ['worker'],
        provider: 'native-local' as const,
      },
      verification: {
        subject: reportSubject,
        checks: [{ id: 'verify-order', status: 'passed' as const }],
      },
      review: {
        subject: reportSubject,
        reviewerId: 'reviewer',
        status: 'approved' as const,
      },
    };
    const previous = readFileSync(join(repository, sourcePath));
    writeFileSync(join(repository, sourcePath), 'unexpected edit');
    expect(() =>
      Orchestrator.observeContractResult(app.store, observations),
    ).toThrow('REPORT_CODE_CHANGED');
    writeFileSync(join(repository, sourcePath), previous);
    Orchestrator.observeContractResult(app.store, observations);
    expect(
      (await post(accept(scout.id, revision, 'scout-attempt'))).status,
    ).toBe(202);
    expect(await getTask(scout.id)).toMatchObject({
      record: {
        observation: {
          outcome: { status: 'report', report, revision, changedPaths: [] },
        },
        acceptance: { accepted: true },
      },
      delivery: { localCandidate: false, createPr: false, merge: false },
    });
    expect(git('status', '--porcelain')).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(baseRevision);
    expect(
      (
        await post(
          createTask({
            ...ship,
            id: 'bad-link',
            sourceReport: { ...ship.sourceReport, revision: 'a'.repeat(64) },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          createTask({ ...ship, id: 'child-ship', parentTaskId: scout.id }),
        )
      ).status,
    ).toBe(403);
    expect((await post(createTask(ship))).status).toBe(202);
    const mergeShip = {
      ...ship,
      id: 'merge-ship',
      authority: {
        ...ship.authority,
        delivery: { localCandidate: true, createPr: false, merge: true },
      },
    };
    expect((await post(createTask(mergeShip))).status).toBe(202);
    git('switch', '-qc', 'candidate');
    writeFileSync(
      join(repository, sourcePath),
      previous
        .toString()
        .replace('assert.equal', 'pending = false;\nassert.equal'),
    );
    expect(runTest('normal').status).toBe(0);
    expect(runTest('reverse').status).toBe(0);
    git('commit', '-qam', 'Reset pending test state');
    const head = git('rev-parse', 'HEAD');
    for (const task of [ship, mergeShip]) {
      const observed = valid({ ...fixture, task }, 'attempt-' + task.id, head);
      Orchestrator.observeContractResult(app.store, {
        ...observed,
        commandId: 'observe-' + task.id,
        taskId: task.id,
        expectedVersion: 1,
        outcome: {
          status: 'candidate',
          revision: head,
          producers: ['worker'],
          provider: 'native-local' as const,
        },
      });
      expect(await getTask(task.id)).toMatchObject({
        record: {
          task: {
            ownerIntent: { objective: 'Fix it' },
            sourceReport: ship.sourceReport,
          },
          observation: {
            outcome: { revision: head, changedPaths: [sourcePath] },
          },
        },
        decision: { eligibleForAutomaticAcceptance: true },
        delivery: { localCandidate: true, createPr: false, merge: false },
      });
      const cmd = accept(task.id, head, observed.attemptId);
      if (task.id === mergeShip.id) {
        expect((await post(cmd)).status).toBe(202);
        expect(await getTask(task.id)).toMatchObject({
          delivery: mergeShip.authority.delivery,
        });
      } else {
        writeFileSync(join(root, 'accept.json'), JSON.stringify(cmd));
      }
    }
  } finally {
    await app.close();
  }
  expect(
    JSON.parse(cli('contracts', 'apply', '--file', join(root, 'accept.json'))),
  ).toMatchObject({
    acceptance: { accepted: true },
  });
  expect(JSON.parse(cli('contracts', 'task', ship.id))).toMatchObject({
    delivery: ship.authority.delivery,
  });
  expect(
    JSON.parse(cli('contracts', 'backlog', fixture.project.id, '1')),
  ).toMatchObject({
    status: 'current',
    backlog: backlogPlan(),
  });
  expect(git('rev-parse', 'main')).toBe(baseRevision);
  expect(git('remote')).toBe('');
});

it('observes an out-of-scope path even when a later commit reverts the edit', () => {
  const { repository, git, baseRevision } = repoFixture();
  const fixture = records(repository);
  fixture.task.baseRevision = baseRevision;
  setup(fixture);
  writeFileSync(join(repository, 'outside.cjs'), 'outside');
  git('add', 'outside.cjs');
  git('commit', '-qm', 'Out of scope');
  git('rm', 'outside.cjs');
  git('commit', '-qm', 'Remove scope violation from the final tree');
  const head = git('rev-parse', 'HEAD');
  Orchestrator.observeContractResult(store, {
    commandId: 'observe-real-paths',
    taskId: 'ship',
    expectedVersion: 1,
    attemptId: 'attempt',
    outcome: {
      status: 'candidate',
      revision: head,
      producers: ['worker'],
      provider: 'native-local' as const,
    },
  });
  expect(store.contracts.getTask('ship')).toMatchObject({
    record: { observation: { outcome: { changedPaths: ['outside.cjs'] } } },
    decision: { blockers: ['scope_violation'], readyForHumanReview: false },
  });
});

it('migrates a pre-A01 SQLite database while preserving manual legacy acceptance', () => {
  store.close();
  rmSync(join(root, 'state.sqlite'));
  const { repository, git, baseRevision } = repoFixture();
  const branch = 'xvant/legacy';
  git('switch', '-qc', branch);
  const legacy: RootState = {
    phase: 'ready',
    repository,
    objective: 'Legacy review',
    acceptanceCriteria: ['Inspect manually'],
    plan: null,
    nodes: {},
    integration: {
      branch,
      path: repository,
      baseCommit: baseRevision,
      head: baseRevision,
    },
    checks: [],
    review: null,
  };
  const db = new Database(join(root, 'state.sqlite'));
  db.exec(
    readFileSync(
      new URL('../../../tests/fixtures/a01-v5-schema.sql', import.meta.url),
      'utf8',
    ),
  );
  expect(db.pragma('user_version', { simple: true })).toBe(5);
  db.prepare('INSERT INTO work_graphs VALUES(?,?,?)').run(
    'legacy',
    'flaky',
    JSON.stringify({
      id: 'legacy',
      projectId: 'flaky',
      rowVersion: 2,
      state: legacy,
    }),
  );
  db.prepare(
    "INSERT INTO work_events(graph_id, kind, payload) VALUES('legacy', 'graph.ready', '{}')",
  ).run();
  db.close();
  store = open();
  expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
  expect(store.graphs.get('legacy').state).toEqual(legacy);
  expect(() => store.contracts.apply(accept('legacy', baseRevision))).toThrow(
    'NOT_FOUND',
  );
  expect(store.graphs.get('legacy').state).toEqual(legacy);
  store.close();
  expect(cli('accept', 'legacy')).toContain('Accepted.');
  store = open();
  expect(store.graphs.get<RootState>('legacy')).toMatchObject({
    rowVersion: 3,
    state: { phase: 'accepted' },
  });
  expect(store.graphs.events('legacy').map(({ kind }) => kind)).toEqual([
    'graph.ready',
    'graph.accepted',
  ]);
  expect(() => store.contracts.getTask('legacy')).toThrow('NOT_FOUND');
});
