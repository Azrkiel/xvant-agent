import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutingProfiles } from '../../../packages/evaluation/src/profile.ts';
import { defaultWorkers } from './app.ts';
import { activeRouting, applyRouting, routingDir } from './routing-default.ts';

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
