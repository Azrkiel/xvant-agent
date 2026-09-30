import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DomainError } from '../../contracts/src/index.ts';
import {
  skillManifestSchema,
  skillPinSchema,
} from '../../contracts/src/skills.ts';
import type { SkillManifest, SkillPin } from '../../contracts/src/skills.ts';
import { canonicalJson } from '../../context/src/packet.ts';
import { safePath } from '../../storage/src/artifacts.ts';
import type { ArtifactStore } from '../../storage/src/artifacts.ts';

export interface SkillEntry {
  manifest: SkillManifest;
  instructions: string;
  /** SHA-256 of the canonical {manifest, instructions} bundle; also its artifact hash. */
  hash: string;
}
export type SkillCatalog = ReadonlyMap<string, SkillEntry>;
const MAX_FILE = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const digest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const bundle = (manifest: SkillManifest, instructions: string) =>
  canonicalJson({ manifest, instructions });

function readBounded(path: string): Buffer {
  let full: string;
  try {
    full = safePath(path);
  } catch {
    throw new DomainError('PATH_DENIED', 'Skill files cannot be links');
  }
  const stat = lstatSync(full);
  if (!stat.isFile() || stat.nlink !== 1)
    throw new DomainError('PATH_DENIED', 'Skill files must be regular files');
  if (stat.size > MAX_FILE)
    throw new DomainError('LIMIT_EXCEEDED', 'Skill file is too large');
  return readFileSync(full);
}
function entryFrom(
  manifestValue: unknown,
  instructionBytes: Buffer,
  where: string,
): SkillEntry {
  const parsed = skillManifestSchema.safeParse(manifestValue);
  if (!parsed.success)
    throw new DomainError('INVALID_INPUT', 'Invalid skill manifest: ' + where);
  if (digest(instructionBytes) !== parsed.data.instructionsHash)
    throw new DomainError(
      'INVALID_EVIDENCE',
      'Skill instructions do not match their manifest hash: ' + where,
    );
  let instructions: string;
  try {
    instructions = utf8.decode(instructionBytes);
  } catch {
    throw new DomainError('INVALID_INPUT', 'Skill instructions are not UTF-8');
  }
  return {
    manifest: parsed.data,
    instructions,
    hash: digest(bundle(parsed.data, instructions)),
  };
}

/**
 * Load `<dir>/<id>/{manifest.json,SKILL.md}`. Links are refused, manifests
 * are strict (no permission-granting fields exist), and the instructions must
 * match the manifest's declared hash.
 */
export function loadSkillCatalog(dir: string): SkillCatalog {
  if (!isAbsolute(dir))
    throw new DomainError('INVALID_INPUT', 'Skill directory must be absolute');
  const root = readdirSync(safePath(dir), { withFileTypes: true });
  const catalog = new Map<string, SkillEntry>();
  for (const item of root.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (item.isSymbolicLink())
      throw new DomainError('PATH_DENIED', 'Skill folders cannot be links');
    if (!item.isDirectory()) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(
        utf8.decode(readBounded(join(dir, item.name, 'manifest.json'))),
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('INVALID_INPUT', 'Unreadable skill manifest');
    }
    let instructions: Buffer;
    try {
      instructions = readBounded(join(dir, item.name, 'SKILL.md'));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      instructions = Buffer.alloc(0);
    }
    const entry = entryFrom(manifest, instructions, item.name);
    if (entry.manifest.id !== item.name)
      throw new DomainError(
        'INVALID_INPUT',
        'Skill folder and manifest id differ',
      );
    catalog.set(entry.manifest.id, entry);
  }
  return catalog;
}

/**
 * Resolve requested skills with exact-version dependencies, dependencies
 * first. Selection only narrows: a skill whose tools are outside the task
 * catalog, or whose runtime is unsupported, is refused, never accommodated.
 */
export function selectSkills(
  catalog: SkillCatalog,
  request: {
    ids: readonly string[];
    runtime: string;
    allowedTools: readonly string[];
    maxContextTokens: number;
  },
): SkillEntry[] {
  const ordered: SkillEntry[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string, version?: string): void => {
    const entry = catalog.get(id);
    if (!entry) throw new DomainError('NOT_FOUND', 'Unknown skill: ' + id);
    if (version !== undefined && entry.manifest.version !== version)
      throw new DomainError('CONFLICT', 'Skill version mismatch: ' + id);
    if (done.has(id)) return;
    if (visiting.has(id))
      throw new DomainError('INVALID_INPUT', 'Skill dependency cycle');
    visiting.add(id);
    for (const dependency of entry.manifest.dependencies)
      visit(dependency.id, dependency.version);
    visiting.delete(id);
    done.add(id);
    ordered.push(entry);
  };
  for (const id of request.ids) visit(id);
  for (const { manifest } of ordered) {
    if (!manifest.runtimes.includes(request.runtime as never))
      throw new DomainError(
        'CAPABILITY_UNSUPPORTED',
        'Skill does not support this runtime: ' + manifest.id,
      );
    if (
      !manifest.requiredTools.every((tool) =>
        request.allowedTools.includes(tool),
      )
    )
      throw new DomainError(
        'CAPABILITY_UNSUPPORTED',
        'Skill needs tools outside this task catalog: ' + manifest.id,
      );
  }
  const tokens = ordered.reduce(
    (sum, entry) => sum + entry.manifest.maxContextTokens,
    0,
  );
  if (tokens > request.maxContextTokens)
    throw new DomainError('LIMIT_EXCEEDED', 'Skills exceed the context budget');
  return ordered;
}

/** Copy each selected skill into the artifact store so the task keeps its exact version. */
export function pinSkills(
  entries: readonly SkillEntry[],
  objects: ArtifactStore,
): SkillPin[] {
  return entries.map((entry) => {
    const hash = objects.put(
      Buffer.from(bundle(entry.manifest, entry.instructions)),
    );
    if (hash !== entry.hash)
      throw new DomainError('INVALID_EVIDENCE', 'Skill bundle hash mismatch');
    return {
      id: entry.manifest.id,
      version: entry.manifest.version,
      hash,
    };
  });
}

/**
 * Load pinned skills from the artifact store, independent of the files on
 * disk. A missing pin stops the task; it never falls back to a newer copy.
 */
export function loadPinnedSkills(
  pins: readonly SkillPin[],
  objects: ArtifactStore,
): SkillEntry[] {
  return pins.map((value) => {
    const pin = skillPinSchema.safeParse(value);
    if (!pin.success) throw new DomainError('INVALID_INPUT', 'Invalid pin');
    let bytes: Buffer;
    try {
      bytes = objects.get(pin.data.hash);
    } catch {
      throw new DomainError('NOT_FOUND', 'Pinned skill is unavailable');
    }
    let stored: { manifest: unknown; instructions: string };
    try {
      stored = JSON.parse(bytes.toString('utf8')) as typeof stored;
    } catch {
      throw new DomainError('INVALID_EVIDENCE', 'Pinned skill is corrupt');
    }
    const entry = entryFrom(
      stored.manifest,
      Buffer.from(String(stored.instructions), 'utf8'),
      pin.data.id,
    );
    if (
      entry.hash !== pin.data.hash ||
      entry.manifest.id !== pin.data.id ||
      entry.manifest.version !== pin.data.version
    )
      throw new DomainError('INVALID_EVIDENCE', 'Pinned skill does not match');
    return entry;
  });
}
