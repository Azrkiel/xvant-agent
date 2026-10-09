import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutingProfiles } from '../../../packages/evaluation/src/profile.ts';
import { defaultWorkers } from './app.ts';
import {
  activeRouting,
  applyRouting,
  applyTiers,
  routingDir,
} from './routing-default.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const roles = (workers: ReturnType<typeof defaultWorkers>) =>
  Object.fromEntries(workers.map((w) => [w.alias, [w.roles.join(), w.model]]));

it('a state directory has no routing default until one is recorded', () => {
  const home = mkdtempSync(join(tmpdir(), 'xvant-routing-'));
  dirs.push(home);
  expect(activeRouting(home)).toBeNull();
  new RoutingProfiles(routingDir(home)).initialize({
    version: 'default',
    settings: { models: { claude: 'haiku' }, plannerModel: 'opus' },
  });
  expect(activeRouting(home)!.settings.plannerModel).toBe('opus');
});

it('sets runtime models and moves planning to one worker on the named runtime', () => {
  const workers = defaultWorkers(['codex', 'claude']);
  const runtimes: Record<string, { model?: string }> = {
    codex: {},
    claude: {},
  };
  const notes = applyRouting(workers, runtimes, {
    models: { claude: 'haiku', opencode: 'big-pickle' },
    plannerModel: 'opus',
  });
  expect(runtimes).toEqual({ codex: {}, claude: { model: 'haiku' } });
  expect(roles(workers)).toEqual({
    'codex-1': ['worker,reviewer', undefined],
    'codex-2': ['worker', undefined],
    'claude-1': ['planner,reviewer', 'opus'],
    'claude-2': ['worker,reviewer', undefined],
    'claude-3': ['worker', undefined],
  });
  expect(notes).toEqual([
    'claude model haiku',
    'claude-1 plans and reviews on opus',
  ]);
});

it('leaves planning alone when the planner runtime is absent or nobody else could implement', () => {
  const codexOnly = defaultWorkers(['codex']);
  const before = roles(codexOnly);
  expect(
    applyRouting(
      codexOnly,
      { codex: {} },
      {
        models: { claude: 'haiku' },
        plannerModel: 'opus',
      },
    ),
  ).toEqual(['planner model opus not applied: its runtime is absent']);
  expect(roles(codexOnly)).toEqual(before);
  const one = defaultWorkers(['claude']).slice(0, 1);
  expect(
    applyRouting(
      one,
      { claude: {} },
      {
        models: { claude: 'haiku' },
        plannerModel: 'opus',
      },
    ),
  ).toEqual([
    'claude model haiku',
    'planner model opus not applied: no other worker to implement',
  ]);
  expect(one[0]!.model).toBeUndefined();
});

it('does not guess the planner runtime when several named runtimes are present', () => {
  const workers = defaultWorkers(['codex', 'claude']);
  const before = roles(workers);
  expect(
    applyRouting(
      workers,
      { codex: {}, claude: {} },
      { models: { codex: 'gpt', claude: 'haiku' }, plannerModel: 'opus' },
    ).at(-1),
  ).toBe(
    'planner model opus not applied: more than one named runtime is present',
  );
  expect(roles(workers)).toEqual(before);
});

it('splits one runtime into tiers after the planner is chosen', () => {
  const workers = defaultWorkers(['codex', 'claude']);
  applyRouting(
    workers,
    { codex: {}, claude: {} },
    { models: { claude: 'default' }, plannerModel: 'opus' },
  );
  expect(
    applyTiers(workers, 'claude', { light: 'haiku', standard: 'sonnet' }),
  ).toEqual(['claude-2 standard on sonnet', 'claude-3 light on haiku']);
  expect(
    Object.fromEntries(workers.map((w) => [w.alias, [w.model, w.tier]])),
  ).toEqual({
    'codex-1': [undefined, undefined],
    'codex-2': [undefined, undefined],
    'claude-1': ['opus', undefined],
    'claude-2': ['sonnet', 'standard'],
    'claude-3': ['haiku', 'light'],
  });
});

it('tiers every Claude implementer when another runtime plans', () => {
  const workers = defaultWorkers(['codex', 'claude']);
  applyRouting(
    workers,
    { codex: {}, claude: {} },
    { models: { codex: 'default' }, plannerModel: 'gpt-6.1-sol' },
  );
  expect(applyTiers(workers, 'claude', { light: 'haiku' })).toEqual([
    'claude-1 standard',
    'claude-2 standard',
    'claude-3 light on haiku',
  ]);
  expect(workers.find((w) => w.alias === 'codex-1')).toMatchObject({
    roles: ['planner', 'reviewer'],
    model: 'gpt-6.1-sol',
  });
});
