import { createHash } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.ts';
import type { ContextItem } from '../../contracts/src/context.ts';
import type { MemoryRecord } from '../../contracts/src/memory.ts';

/** Current content hash per repository-relative path (SHA-256 of file bytes). */
export interface FileHash {
  path: string;
  hash: string;
}
export interface AssessedMemory {
  record: MemoryRecord;
  /** `unanchored` records name no files, so code changes cannot be checked against them. */
  freshness: 'current' | 'stale' | 'unanchored';
  changed: string[];
}
export type MemoryExclusion =
  'cross_project' | 'rejected' | 'stale' | 'superseded' | 'unaccepted';

/** Anchor a record to the current content of the files it depends on. */
export function anchorFiles(
  files: readonly FileHash[],
  paths: readonly string[],
): FileHash[] {
  if (new Set(paths).size !== paths.length)
    throw new DomainError('INVALID_INPUT', 'Duplicate anchor path');
  const current = new Map(files.map((file) => [file.path, file.hash]));
  return paths.map((path) => {
    const hash = current.get(path);
    if (!hash) throw new DomainError('NOT_FOUND', 'Anchor file not found');
    return { path, hash };
  });
}

/** Compare each record's anchors with the current workspace; any change makes it stale. */
export function assessMemory(
  records: readonly MemoryRecord[],
  files: readonly FileHash[],
): AssessedMemory[] {
  const current = new Map(files.map((file) => [file.path, file.hash]));
  return records.map((record) => {
    const anchors = record.anchors ?? [];
    const changed = anchors
      .filter((anchor) => current.get(anchor.path) !== anchor.hash)
      .map((anchor) => anchor.path);
    return {
      record,
      freshness: !anchors.length
        ? 'unanchored'
        : changed.length
          ? 'stale'
          : 'current',
      changed,
    };
  });
}
const KIND = {
  fact: 'memory',
  convention: 'memory',
  decision: 'decision',
  failure: 'failure',
  question: 'question',
} as const;
const CONFIDENCE_PRIORITY = { verified: 80, reported: 60, inferred: 40 };
const DECISION_PRIORITY = { accepted: 90, proposed: 30, superseded: 10 };

/**
 * Convert assessed records into optional packet items. Nothing stale,
 * rejected, unaccepted, or from another project is promoted; each exclusion
 * is returned with its reason. Decisions keep their proposed, accepted, or
 * superseded status so recipients see the decision history explicitly.
 */
export function memoryContextItems(
  assessed: readonly AssessedMemory[],
  projectId: string,
): {
  items: ContextItem[];
  excluded: { id: string; reason: MemoryExclusion }[];
} {
  const items: ContextItem[] = [];
  const excluded: { id: string; reason: MemoryExclusion }[] = [];
  for (const { record, freshness } of assessed) {
    const decision = record.kind === 'decision';
    const reason: MemoryExclusion | undefined =
      record.projectId !== projectId
        ? 'cross_project'
        : record.status === 'rejected'
          ? 'rejected'
          : freshness === 'stale'
            ? 'stale'
            : decision
              ? undefined
              : record.status === 'proposed'
                ? 'unaccepted'
                : record.status === 'superseded'
                  ? 'superseded'
                  : undefined;
    if (reason) {
      excluded.push({ id: record.id, reason });
      continue;
    }
    const status = record.status as keyof typeof DECISION_PRIORITY;
    items.push({
      id:
        'mem_' +
        createHash('sha256')
          .update(record.projectId + '/' + record.id)
          .digest('hex')
          .slice(0, 16),
      kind: KIND[record.kind],
      required: false,
      priority: decision
        ? DECISION_PRIORITY[status]
        : CONFIDENCE_PRIORITY[record.confidence],
      content: record.content,
      ...(decision ? { decisionStatus: status } : {}),
      provenance: {
        source: 'memory',
        projectId: record.projectId,
        ref: record.namespace + '#' + record.id,
        contentHash: record.contentHash,
        ...(record.provenance.revision
          ? { revision: record.provenance.revision }
          : {}),
      },
    });
  }
  return { items, excluded };
}
