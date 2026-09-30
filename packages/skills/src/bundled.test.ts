import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerSupervisor } from '../../supervisor/src/index.ts';
import { Store } from '../../storage/src/store.ts';
import { ArtifactStore } from '../../storage/src/artifacts.ts';
import { ToolRegistry } from '../../tools/src/registry.ts';
import { fileApplyPatch, fileRead } from '../../tools/src/files.ts';
import { gitInspect, repoSearch } from '../../tools/src/repository.ts';
import { createProcessTools } from '../../tools/src/process.ts';
import { createControllerTools } from '../../tools/src/controller.ts';
import { loadSkillCatalog, selectSkills } from './catalog.ts';
import { planHooks } from './hooks.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const skillsDir = join(repoRoot, 'skills');
const fixturesDir = join(repoRoot, 'fixtures', 'skills');
const EXPECTED = [
  'diagnose-failure',
  'document-change',
  'evaluate-skill',
  'explore-repository',
  'handoff-work',
  'implement-change',
  'integrate-patches',
  'plan-change',
  'review-change',
  'test-change',
];
let scratch: string;
let toolNames: string[];
beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-bundled-')));
  const store = new Store(join(scratch, 'state.sqlite'), { owner: 'names' });
  toolNames = [
    fileRead,
    fileApplyPatch,
    repoSearch,
    gitInspect,
    ...createProcessTools({
      supervisor: new WorkerSupervisor(),
      testCommands: [],
    }),
    ...createControllerTools({
      store,
      objects: new ArtifactStore(join(scratch, 'o')),
    }),
  ].map((tool) => tool.manifest.name);
  store.close();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('bundled skills', () => {
  it('ships exactly the ten original skills with matching instructions', () => {
    const catalog = loadSkillCatalog(skillsDir);
    expect([...catalog.keys()].sort()).toEqual(EXPECTED);
    for (const { manifest, instructions } of catalog.values()) {
      expect(manifest.origin).toBe('xvant-original');
      for (const tool of manifest.requiredTools)
        expect(toolNames).toContain(tool);
      for (const step of manifest.steps)
        expect(instructions).toContain('### ' + step.id + '\n');
      expect(instructions).toContain('## Stop and escalate');
    }
  });
  it('resolves every dependency and merges shared hooks', () => {
    const catalog = loadSkillCatalog(skillsDir);
    const all = selectSkills(catalog, {
      ids: EXPECTED,
      runtime: 'simulated',
      allowedTools: toolNames,
      maxContextTokens: 200_000,
    });
    expect(all).toHaveLength(10);
    const plan = planHooks(all, {
      handlers: new Map(),
      allowedHooks: [],
      profile: 'read-only',
    });
    expect(plan.requiredChecks).toEqual(['tests']);
    const tests = plan.hooks.find(
      (hook) => hook.action.kind === 'require_check',
    )!;
    expect(tests.sources).toEqual([
      'implement-change/tests-pass',
      'integrate-patches/tests-pass',
      'test-change/tests-pass',
    ]);
  });
  it('gives every skill fixtures that point back to it', () => {
    const catalog = loadSkillCatalog(skillsDir);
    const fixtures = readdirSync(fixturesDir).sort();
    const listed = [...catalog.values()].flatMap((entry) =>
      entry.manifest.fixtures.map((id) => [id, entry.manifest.id]),
    );
    expect(listed.map(([id]) => id).sort()).toEqual(fixtures);
    for (const [id, skill] of listed) {
      const fixture = JSON.parse(
        readFileSync(join(fixturesDir, id!, 'fixture.json'), 'utf8'),
      ) as { skill: string; acceptanceCriteria: string[] };
      expect(fixture.skill).toBe(skill);
      expect(fixture.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });
  it.each(readdirSync(fixturesDir).sort())(
    'fixture %s fails untouched and passes with its reference solution',
    async (id) => {
      const dir = join(fixturesDir, id);
      const copy = join(scratch, id);
      cpSync(join(dir, 'repo'), copy, { recursive: true });
      const check = () =>
        spawnSync(process.execPath, [join(dir, 'check.mjs')], {
          cwd: copy,
          encoding: 'utf8',
          timeout: 30_000,
        });
      expect(check().status).not.toBe(0);
      const { edits } = JSON.parse(
        readFileSync(join(dir, 'solution.json'), 'utf8'),
      ) as { edits: { path: string }[] };
      const owned = [...new Set(edits.map((edit) => edit.path.split('/')[0]!))];
      const receipt = await new ToolRegistry([fileApplyPatch], {
        record: () => {},
      }).invoke(
        { tool: 'file.apply_patch', input: { edits } },
        {
          projectId: 'fixtures',
          taskId: 'fixture',
          attemptId: 'attempt',
          workerId: 'reference',
          permissionProfile: 'trusted-local',
          allowedTools: ['file.apply_patch'],
          approvals: [],
          now: () => 1,
          workspace: { root: copy, writablePaths: owned },
        },
      );
      expect(receipt.status).toBe('succeeded');
      const result = check();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    },
    60_000,
  );
});
