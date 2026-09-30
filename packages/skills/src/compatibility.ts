import type { EffectClass } from '../../contracts/src/tools.ts';
import {
  RUNTIME_TOOL_PROFILES,
  admitRuntimeProfile,
} from '../../policy/src/runtimes.ts';
import type { RuntimeToolProfile } from '../../policy/src/runtimes.ts';
import { profileAllows } from '../../policy/src/tools.ts';
import type { SkillCatalog } from './catalog.ts';

export interface CompatibilityRow {
  skill: string;
  runtime: string;
  profile: string;
  /**
   * blocked: the runtime cannot run under this profile at all.
   * unsupported: the skill cannot work here (runtime, tools or effects).
   * unverified: permitted, but a link it depends on has no live evidence.
   */
  status: 'supported' | 'unverified' | 'blocked' | 'unsupported';
  requiresAcknowledgement: boolean;
  reasons: string[];
  risks: string[];
}

/** One row per skill × runtime × profile, with reasons and native-tool bypass risks. */
export function compatibilityMatrix(input: {
  catalog: SkillCatalog;
  tools: readonly { name: string; effect: EffectClass }[];
  profiles: readonly string[];
  runtimes?: readonly RuntimeToolProfile[];
}): CompatibilityRow[] {
  const effects = new Map(input.tools.map((tool) => [tool.name, tool.effect]));
  const rows: CompatibilityRow[] = [];
  const skills = [...input.catalog.values()].sort((a, b) =>
    a.manifest.id < b.manifest.id ? -1 : 1,
  );
  for (const { manifest } of skills)
    for (const runtime of input.runtimes ?? RUNTIME_TOOL_PROFILES)
      for (const profile of input.profiles) {
        const unsupported: string[] = [];
        if (!manifest.runtimes.includes(runtime.runtime))
          unsupported.push('Skill does not list this runtime');
        for (const tool of manifest.requiredTools) {
          const effect = effects.get(tool);
          if (!effect) unsupported.push(`Tool ${tool} is not available`);
          else if (profileAllows(profile, effect) !== 'allowed')
            unsupported.push(`Profile forbids ${tool} (${effect})`);
        }
        const admission = admitRuntimeProfile({
          runtime: runtime.runtime,
          profile,
          acknowledgedNativeBypass: true,
        });
        const unacknowledged = admitRuntimeProfile({
          runtime: runtime.runtime,
          profile,
        });
        const unverified =
          runtime.mcpClient !== 'not-needed' &&
          runtime.mcpClient !== 'tested-live'
            ? [
                `XVANT tools reach this runtime through MCP; client support is ${runtime.mcpClient}`,
              ]
            : [];
        const status = !admission.allowed
          ? 'blocked'
          : unsupported.length
            ? 'unsupported'
            : unverified.length
              ? 'unverified'
              : 'supported';
        rows.push({
          skill: manifest.id,
          runtime: runtime.runtime,
          profile,
          status,
          requiresAcknowledgement:
            !unacknowledged.allowed && unacknowledged.code === 'POLICY_DENIED',
          reasons: [
            ...(admission.allowed ? [] : [admission.reason]),
            ...unsupported,
            ...unverified,
          ],
          risks: admission.risks,
        });
      }
  return rows;
}
