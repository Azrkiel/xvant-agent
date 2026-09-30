import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DomainError, idSchema } from '../../contracts/src/index.ts';
import { revisionSchema } from '../../contracts/src/context.ts';
import { memoryBundleSchema } from '../../contracts/src/memory.ts';
import type {
  MemoryBundle,
  MemoryBundleEntry,
  MemoryProposal,
  MemoryRecord,
} from '../../contracts/src/memory.ts';
import { safePath } from '../../storage/src/artifacts.ts';
import type { ArtifactStore } from '../../storage/src/artifacts.ts';
import { canonicalJson, sha256 } from './packet.ts';
import { readRegular } from './retrieval.ts';
import { containsSecret } from './secrets.ts';

/**
 * Export accepted records of one project as a sealed, portable bundle.
 * Status, task bindings and supersession links stay behind; records with
 * credential-shaped content are withheld and reported.
 */
export function exportMemoryBundle(
  records: readonly MemoryRecord[],
  options: { projectId: string; now: number },
): {
  bundle: MemoryBundle;
  omitted: {
    id: string;
    reason: 'cross_project' | 'not_accepted' | 'secret_content';
  }[];
} {
  const omitted: {
    id: string;
    reason: 'cross_project' | 'not_accepted' | 'secret_content';
  }[] = [];
  const entries: MemoryBundleEntry[] = [];
  for (const record of records) {
    if (record.projectId !== options.projectId)
      omitted.push({ id: record.id, reason: 'cross_project' });
    else if (record.status !== 'accepted')
      omitted.push({ id: record.id, reason: 'not_accepted' });
    else if (containsSecret(record.content))
      omitted.push({ id: record.id, reason: 'secret_content' });
    else
      entries.push({
        id: record.id,
        namespace: record.namespace,
        kind: record.kind,
        content: record.content,
        contentHash: record.contentHash,
        confidence: record.confidence,
        ...(record.anchors ? { anchors: record.anchors } : {}),
        provenance: {
          source: record.provenance.source,
          actorId: record.provenance.actorId,
          ...(record.provenance.revision
            ? { revision: record.provenance.revision }
            : {}),
        },
      });
  }
  const body = {
    version: 1 as const,
    format: 'xvant-memory' as const,
    projectId: options.projectId,
    exportedAt: options.now,
    records: entries,
  };
  const bundle = { ...body, bundleHash: sha256(canonicalJson(body)) };
  if (!memoryBundleSchema.safeParse(bundle).success)
    throw new DomainError('INVALID_INPUT', 'Records cannot be exported');
  return { bundle, omitted };
}

/** Validate a received bundle's schema, per-record content hashes and seal. */
export function verifyMemoryBundle(value: unknown): MemoryBundle {
  const result = memoryBundleSchema.safeParse(value);
  if (!result.success)
    throw new DomainError('INVALID_EVIDENCE', 'Malformed memory bundle');
  const { bundleHash, ...body } = result.data;
  if (
    body.records.some((entry) => sha256(entry.content) !== entry.contentHash) ||
    sha256(canonicalJson(body)) !== bundleHash
  )
    throw new DomainError('INVALID_EVIDENCE', 'Memory bundle seal mismatch');
  return result.data;
}

/**
 * Turn a verified bundle into proposals for the target project. Imported
 * knowledge is never accepted automatically and never keeps `verified`
 * confidence; the importer is recorded as the actor.
 */
export function importMemoryBundle(
  value: unknown,
  options: { projectId: string; actorId: string; revision?: string },
): {
  proposals: MemoryProposal[];
  skipped: { id: string; reason: 'secret_content' }[];
} {
  const bundle = verifyMemoryBundle(value);
  if (
    !idSchema.safeParse(options.projectId).success ||
    !idSchema.safeParse(options.actorId).success ||
    (options.revision !== undefined &&
      !revisionSchema.safeParse(options.revision).success)
  )
    throw new DomainError('INVALID_INPUT', 'Invalid import target');
  const proposals: MemoryProposal[] = [];
  const skipped: { id: string; reason: 'secret_content' }[] = [];
  for (const entry of bundle.records) {
    if (containsSecret(entry.content)) {
      skipped.push({ id: entry.id, reason: 'secret_content' });
      continue;
    }
    const revision = options.revision ?? entry.provenance.revision;
    proposals.push({
      id: entry.id,
      projectId: options.projectId,
      namespace: entry.namespace,
      kind: entry.kind,
      content: entry.content,
      confidence:
        entry.confidence === 'verified' ? 'reported' : entry.confidence,
      ...(entry.anchors ? { anchors: entry.anchors } : {}),
      provenance: {
        source: 'import',
        actorId: options.actorId,
        ...(revision ? { revision } : {}),
      },
    });
  }
  return { proposals, skipped };
}

/**
 * Copy an external text file, such as a vendor session transcript, into the
 * artifact store as data. The source is opened read-only without following
 * links and is never written, renamed or deleted.
 */
export function importExternalFile(
  path: string,
  objects: ArtifactStore,
  options: { maxBytes?: number } = {},
): { hash: string; bytes: number } {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!isAbsolute(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new DomainError('INVALID_INPUT', 'Invalid import path');
  const absolute = safePath(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile())
    throw new DomainError('INVALID_INPUT', 'Import source is not a file');
  if (stat.size > maxBytes)
    throw new DomainError('LIMIT_EXCEEDED', 'Import source is too large');
  const bytes = readRegular(absolute, stat.size);
  if (bytes === 'changed')
    throw new DomainError('STALE_EVIDENCE', 'Import source changed while read');
  let text: string;
  try {
    if (bytes.includes(0)) throw new Error('binary');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError('INVALID_INPUT', 'Import source is not UTF-8 text');
  }
  if (containsSecret(text))
    throw new DomainError(
      'INVALID_INPUT',
      'Import source contains credential-shaped content',
    );
  return { hash: objects.put(bytes), bytes: bytes.length };
}
