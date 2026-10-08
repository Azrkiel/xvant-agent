import { join } from 'node:path';
import {
  RoutingProfiles,
  type RoutingProfile,
  type RoutingSettings,
} from '../../../packages/evaluation/src/profile.ts';
import type { WorkerSpec } from './orchestrator.ts';

/** Where a state directory keeps its routing ledger, defaults and candidates. */
export const routingDir = (home: string) => join(home, 'routing');

/** The promoted routing default of a state directory, or null if none was ever recorded. */
export function activeRouting(home: string): RoutingProfile | null {
  return new RoutingProfiles(routingDir(home)).active();
}

/**
 * Applies routing settings to a pool in place and says what it did. Models
 * go to the runtimes the settings name. A planner model applies only to a
 * runtime the settings name, since a model of one runtime means nothing to
 * another: the first worker on it plans and reviews and implements nothing,
 * provided another worker is left to implement.
 */
export function applyRouting(
  workers: WorkerSpec[],
  runtimes: Partial<Record<string, { model?: string }>>,
  settings: RoutingSettings,
): string[] {
  const notes: string[] = [];
  for (const [kind, model] of Object.entries(settings.models)) {
    const runtime = runtimes[kind];
    if (!runtime) continue;
    runtime.model = model;
    notes.push(kind + ' model ' + model);
  }
  if (!settings.plannerModel) return notes;
  const planner = workers.find(
    (w) => w.runtimeKind in settings.models && runtimes[w.runtimeKind],
  );
  if (
    !planner ||
    !workers.some((w) => w !== planner && w.roles.includes('worker'))
  ) {
    notes.push(
      'planner model ' +
        settings.plannerModel +
        ' not applied: ' +
        (planner ? 'no other worker to implement' : 'its runtime is absent'),
    );
    return notes;
  }
  for (const worker of workers)
    if (worker !== planner)
      worker.roles = worker.roles.filter((r) => r !== 'planner');
  planner.roles = ['planner', 'reviewer'];
  planner.model = settings.plannerModel;
  notes.push(planner.alias + ' plans and reviews on ' + settings.plannerModel);
  return notes;
}
