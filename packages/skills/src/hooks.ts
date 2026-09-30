import { DomainError } from '../../contracts/src/index.ts';
import { lifecycleEventSchema } from '../../contracts/src/skills.ts';
import type { HookDeclaration } from '../../contracts/src/skills.ts';
import type { EffectClass } from '../../contracts/src/tools.ts';
import { canonicalJson } from '../../context/src/packet.ts';
import { profileAllows } from '../../policy/src/tools.ts';
import type { SkillEntry } from './catalog.ts';

type LifecycleEvent = HookDeclaration['event'];
/** Host-registered code behind an `executable` hook. Skills can only name it. */
export interface HookHandler {
  effect: EffectClass;
  run(payload: Readonly<Record<string, unknown>>): Promise<void>;
}
export interface PlannedHook {
  event: LifecycleEvent;
  action: HookDeclaration['action'];
  sources: string[];
}
export interface HookPlan {
  hooks: PlannedHook[];
  /** Checks skills add to acceptance. Hooks can only add requirements. */
  requiredChecks: string[];
  handlers: ReadonlyMap<string, HookHandler>;
}
const EVENTS = lifecycleEventSchema.options;

/**
 * Merge the selected skills' hook declarations. Identical event+action pairs
 * collapse into one hook. Executable hooks must name host-registered code
 * that this task allows and whose effect the permission profile admits.
 */
export function planHooks(
  skills: readonly SkillEntry[],
  host: {
    handlers: ReadonlyMap<string, HookHandler>;
    allowedHooks: readonly string[];
    profile: string;
  },
): HookPlan {
  const merged = new Map<string, PlannedHook>();
  for (const { manifest } of skills)
    for (const hook of manifest.hooks) {
      if (hook.action.kind === 'executable') {
        const handler = host.handlers.get(hook.action.handler);
        if (!handler)
          throw new DomainError(
            'CAPABILITY_UNSUPPORTED',
            'No registered code for hook ' + hook.action.handler,
          );
        if (!host.allowedHooks.includes(hook.action.handler))
          throw new DomainError(
            'POLICY_DENIED',
            'Hook is not allowed for this task: ' + hook.action.handler,
          );
        const allowed = profileAllows(host.profile, handler.effect);
        if (allowed !== 'allowed')
          throw new DomainError(
            allowed === 'unsupported'
              ? 'CAPABILITY_UNSUPPORTED'
              : 'POLICY_DENIED',
            'The permission profile does not admit this hook',
          );
      }
      const key = canonicalJson({ event: hook.event, action: hook.action });
      const source = manifest.id + '/' + hook.id;
      const existing = merged.get(key);
      if (existing) existing.sources.push(source);
      else
        merged.set(key, {
          event: hook.event,
          action: hook.action,
          sources: [source],
        });
    }
  const hooks = [...merged.entries()]
    .sort(
      ([keyA, a], [keyB, b]) =>
        EVENTS.indexOf(a.event) - EVENTS.indexOf(b.event) ||
        (keyA < keyB ? -1 : 1),
    )
    .map(([, hook]) => ({ ...hook, sources: hook.sources.sort() }));
  const requiredChecks = [
    ...new Set(
      hooks.flatMap((hook) =>
        hook.action.kind === 'require_check' ? [hook.action.checkId] : [],
      ),
    ),
  ].sort();
  return { hooks, requiredChecks, handlers: host.handlers };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Runs a hook plan. Each hook fires at most once per (event, key). */
export class HookRunner {
  readonly #plan: HookPlan;
  readonly #timeoutMs: number;
  readonly #fired = new Set<string>();
  constructor(plan: HookPlan, options: { timeoutMs?: number } = {}) {
    this.#plan = plan;
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }
  async dispatch(
    event: LifecycleEvent,
    key: string,
    payload: Record<string, unknown>,
  ): Promise<{
    evidence: { label: string; sources: string[]; key: string }[];
    failures: { handler: string; code: 'HOOK_FAILED' | 'TIMEOUT' }[];
  }> {
    const evidence: { label: string; sources: string[]; key: string }[] = [];
    const failures: { handler: string; code: 'HOOK_FAILED' | 'TIMEOUT' }[] = [];
    for (const [index, hook] of this.#plan.hooks.entries()) {
      if (hook.event !== event) continue;
      const once = index + '\0' + key;
      if (this.#fired.has(once)) continue;
      this.#fired.add(once);
      const { action } = hook;
      if (action.kind === 'record_evidence')
        evidence.push({ label: action.label, sources: [...hook.sources], key });
      if (action.kind !== 'executable') continue;
      const handler = this.#plan.handlers.get(action.handler)!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          handler
            .run(freeze(structuredClone(payload)))
            .then(() => 'ok' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.#timeoutMs);
          }),
        ]);
        if (outcome === 'timeout')
          failures.push({ handler: action.handler, code: 'TIMEOUT' });
      } catch {
        failures.push({ handler: action.handler, code: 'HOOK_FAILED' });
      } finally {
        clearTimeout(timer);
      }
    }
    return { evidence, failures };
  }
}
