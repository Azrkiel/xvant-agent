import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../storage/src/store.ts';
import { ArtifactStore } from '../../storage/src/artifacts.ts';
import { ToolRegistry } from './registry.ts';
import type { ToolContext } from './registry.ts';
import { createControllerTools } from './controller.ts';
import type { WorkRequest } from './controller.ts';

const TOKEN = 'ghp_' + 'c5'.repeat(18);
let root: string;
let store: Store;
let objects: ArtifactStore;
function task(id: string, projectId: string, workerId: string) {
  store.create('create-' + id, {
    id,
    projectId,
    objective: 'Objective ' + id,
    requiredCheckIds: ['test'],
    acceptanceCriteria: ['Criterion ' + id],
  });
  store.queue('queue-' + id, id, 0);
  store.dispatch('dispatch-' + id, {
    taskId: id,
    workerId,
    attemptId: 'attempt-' + id,
    workspaceId: 'workspace-' + id,
    sessionId: 'session-' + id,
    scenario: 'success',
    expectedVersion: store.getTask(id).rowVersion,
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-controller-tools-'));
  store = new Store(join(root, 'state.sqlite'), { owner: 'controller' });
  objects = new ArtifactStore(join(root, 'objects'));
  task('task', 'project', 'codex-1');
  task('sibling', 'project', 'codex-2');
  task('foreign', 'other', 'claude-1');
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
function setup(requests: WorkRequest[] = [], extra: Partial<ToolContext> = {}) {
  const tools = createControllerTools({
    store,
    objects,
    requestWork: (request) => {
      requests.push(request);
      if (requests.length > 2) throw new Error('LIMIT_EXCEEDED');
      return { taskId: 'child-' + requests.length };
    },
  });
  const registry = new ToolRegistry(tools, { record: () => {} });
  const context: ToolContext = {
    projectId: 'project',
    taskId: 'task',
    attemptId: 'attempt-task',
    workerId: 'codex-1',
    permissionProfile: 'read-only',
    allowedTools: tools.map((tool) => tool.manifest.name),
    approvals: [],
    now: () => 1,
    workspace: { root, writablePaths: [], baseRevision: 'a'.repeat(40) },
    ...extra,
  };
  return (tool: string, input: unknown, more: Partial<ToolContext> = {}) =>
    registry.invoke({ tool, input }, { ...context, ...more });
}

describe('artifact.publish', () => {
  it('stores immutable content bound to the task and lists it on the receipt', async () => {
    const call = setup();
    const receipt = await call('artifact.publish', {
      mediaType: 'text/markdown',
      description: 'Investigation notes',
      content: '# Notes\n',
    });
    expect(receipt.status).toBe('succeeded');
    const { hash } = receipt.result as { hash: string };
    expect(receipt.artifacts).toEqual([hash]);
    expect(objects.get(hash).toString()).toBe('# Notes\n');
    expect(store.artifactHashes()).toContain(hash);
    expect(
      (
        await call('artifact.publish', {
          mediaType: 'text/plain',
          description: 'leak',
          content: 'token ' + TOKEN,
        })
      ).code,
    ).toBe('INVALID_INPUT');
  });
});

describe('agent.read_result', () => {
  it('reads tasks of the same project and hides others', async () => {
    const call = setup();
    expect(
      await call('agent.read_result', { taskId: 'sibling' }),
    ).toMatchObject({
      status: 'succeeded',
      result: {
        taskId: 'sibling',
        state: 'running',
        objective: 'Objective sibling',
        acceptanceCriteria: ['Criterion sibling'],
      },
    });
    for (const taskId of ['foreign', 'missing'])
      expect((await call('agent.read_result', { taskId })).code).toBe(
        'NOT_FOUND',
      );
  });
});

describe('agent.request_work', () => {
  it('submits bounded child work attributed by the host and surfaces limits', async () => {
    const requests: WorkRequest[] = [];
    const call = setup(requests);
    const spec = {
      objective: 'Write the retry test',
      acceptanceCriteria: ['Test fails without the limit'],
      requiredCheckIds: ['unit'],
    };
    expect(await call('agent.request_work', spec)).toMatchObject({
      status: 'succeeded',
      result: { taskId: 'child-1' },
    });
    expect(requests[0]).toEqual({
      projectId: 'project',
      parentTaskId: 'task',
      requestedBy: { workerId: 'codex-1', attemptId: 'attempt-task' },
      spec: { ...spec, dependsOn: [] },
    });
    await call('agent.request_work', spec);
    expect((await call('agent.request_work', spec)).code).toBe(
      'LIMIT_EXCEEDED',
    );
    expect(
      (await call('agent.request_work', { ...spec, parentTaskId: 'foreign' }))
        .code,
    ).toBe('INVALID_INPUT');
  });
  it('is unsupported when the host provides no scheduler', async () => {
    const tools = createControllerTools({ store, objects });
    const registry = new ToolRegistry(tools, { record: () => {} });
    const receipt = await registry.invoke(
      {
        tool: 'agent.request_work',
        input: {
          objective: 'x',
          acceptanceCriteria: ['y'],
          requiredCheckIds: ['z'],
        },
      },
      {
        projectId: 'project',
        taskId: 'task',
        attemptId: 'attempt-task',
        workerId: 'codex-1',
        permissionProfile: 'read-only',
        allowedTools: ['agent.request_work'],
        approvals: [],
        now: () => 1,
      },
    );
    expect(receipt.code).toBe('CAPABILITY_UNSUPPORTED');
  });
});

describe('memory tools', () => {
  it('proposes with host-forced provenance and searches only this project', async () => {
    const call = setup();
    const proposed = await call('memory.propose', {
      id: 'retry-rule',
      namespace: 'architecture',
      kind: 'convention',
      content: 'Retries always use MAX_RETRIES',
      confidence: 'reported',
    });
    expect(proposed).toMatchObject({
      status: 'succeeded',
      result: { id: 'retry-rule', status: 'proposed' },
    });
    expect(store.memory.get('project', 'retry-rule').provenance).toEqual({
      source: 'worker',
      actorId: 'codex-1',
      taskId: 'task',
      attemptId: 'attempt-task',
      revision: 'a'.repeat(40),
    });
    expect(
      (
        await call('memory.propose', {
          id: 'claim',
          namespace: 'architecture',
          kind: 'fact',
          content: 'I verified everything',
          confidence: 'verified',
        })
      ).code,
    ).toBe('INVALID_INPUT');
    expect(
      (
        await call(
          'memory.propose',
          {
            id: 'late',
            namespace: 'architecture',
            kind: 'fact',
            content: 'from an old attempt',
            confidence: 'inferred',
          },
          { attemptId: 'attempt-0' },
        )
      ).code,
    ).toBe('STALE_ATTEMPT');
    store.memory.decide('project', 'retry-rule', {
      decision: 'accept',
      actorId: 'owner',
      expectedVersion: 0,
    });
    store.memory.propose({
      id: 'other-rule',
      projectId: 'other',
      namespace: 'architecture',
      kind: 'convention',
      content: 'Retries in the other project',
      confidence: 'reported',
      provenance: { source: 'user', actorId: 'owner' },
    });
    store.memory.decide('other', 'other-rule', {
      decision: 'accept',
      actorId: 'owner',
      expectedVersion: 0,
    });
    const found = await call('memory.search', { query: 'retries' });
    expect(
      (found.result as { records: { id: string }[] }).records.map((r) => r.id),
    ).toEqual(['retry-rule']);
  });
});

describe('lessons.search', () => {
  it("finds the task's own project's challenges and what fixed them", async () => {
    const call = setup();
    const learn = (projectId: string, summary: string) => {
      const challenge = store.lessons.recordChallenge({
        projectId,
        failure: 'Checks failed: unit\nTypeError: parse is not a function',
        source: 'node',
        provenance: { graphId: 'g' },
      });
      const fix = store.lessons.recordSolution({
        projectId,
        summary,
        files: ['src/parse.js'],
        diff: '+export { parse };',
        checks: ['unit'],
        provenance: { graphId: 'g' },
      });
      store.lessons.link(projectId, challenge.id, fix.id, 'solved_by');
    };
    learn('project', 'Exported parse');
    learn('other', 'Foreign fix');
    // The caller's context names another project; the task record decides.
    const receipt = await call(
      'lessons.search',
      { query: 'TypeError: parse is not a function' },
      { projectId: 'other' },
    );
    expect(receipt.status).toBe('succeeded');
    const { matches } = receipt.result as {
      matches: {
        challenge: { exact: boolean };
        solved_by: { summary: string; verifiedBy: string[] }[];
      }[];
    };
    expect(matches).toHaveLength(1);
    expect(matches[0]!.solved_by).toMatchObject([
      { summary: 'Exported parse', verifiedBy: ['unit'] },
    ]);
    expect(
      (
        (await call('lessons.search', { query: 'unrelated lint warning' }))
          .result as { matches: unknown[] }
      ).matches,
    ).toEqual([]);
  });
});
