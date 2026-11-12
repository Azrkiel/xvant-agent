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
const preferredReviewers = (workers: ReturnType<typeof defaultWorkers>) =>
  workers.filter((w) => w.preferredReviewer).map((w) => w.alias);

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
  expect(preferredReviewers(workers)).toEqual(['claude-1']);
  expect(notes).toEqual([
    'claude model haiku',
    'claude-1 plans and reviews on opus',
  ]);
});

it('leaves review routing alone without a planner model', () => {
  const workers = defaultWorkers(['codex', 'claude']);
  const before = roles(workers);
  const runtimes = { codex: {}, claude: {} };
  expect(applyRouting(workers, runtimes, { models: { codex: 'gpt' } })).toEqual(
    ['codex model gpt'],
  );
  expect(runtimes).toEqual({ codex: { model: 'gpt' }, claude: {} });
  expect(roles(workers)).toEqual(before);
  expect(preferredReviewers(workers)).toEqual([]);
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
  expect(preferredReviewers(codexOnly)).toEqual([]);
  const one = defaultWorkers(['claude']).slice(0, 1);
  const oneBefore = roles(one);
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
  expect(roles(one)).toEqual(oneBefore);
  expect(preferredReviewers(one)).toEqual([]);
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
  expect(preferredReviewers(workers)).toEqual([]);
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
  expect(preferredReviewers(workers)).toEqual(['claude-1']);
  expect(
    workers.filter((w) => w.roles.includes('reviewer')).map((w) => w.alias),
  ).toEqual(['codex-1', 'claude-1', 'claude-2']);
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
    preferredReviewer: true,
  });
  expect(preferredReviewers(workers)).toEqual(['codex-1']);
  expect(roles(workers)).toEqual({
    'codex-1': ['planner,reviewer', 'gpt-6.1-sol'],
    'codex-2': ['worker', undefined],
    'claude-1': ['worker,reviewer', undefined],
    'claude-2': ['worker,reviewer', undefined],
    'claude-3': ['worker', 'haiku'],
  });
  expect(
    applyTiers(workers, 'codex', {
      light: 'gpt-light',
      standard: 'gpt-standard',
    }),
  ).toEqual(['codex-2 light on gpt-light']);
  expect(
    Object.fromEntries(workers.map((w) => [w.alias, [w.model, w.tier]])),
  ).toEqual({
    'codex-1': ['gpt-6.1-sol', undefined],
    'codex-2': ['gpt-light', 'light'],
    'claude-1': [undefined, 'standard'],
    'claude-2': [undefined, 'standard'],
    'claude-3': ['haiku', 'light'],
  });
  expect(preferredReviewers(workers)).toEqual(['codex-1']);
});
