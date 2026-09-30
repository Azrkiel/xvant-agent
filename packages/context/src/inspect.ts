import type { ContextPacket } from '../../contracts/src/context.ts';
import type {
  AssessedMemory,
  MemoryExclusion,
} from '../../memory/src/relevance.ts';
import type { OmissionReason } from './retrieval.ts';
import { verifyContextPacket } from './packet.ts';

export interface InspectionEntry {
  stage: 'retrieval' | 'memory' | 'packet';
  ref: string;
  decision: 'included' | 'omitted';
  reason: string;
  kind?: string;
  tokens?: number;
  freshness?: AssessedMemory['freshness'];
  changed?: string[];
}
export interface ContextInspection {
  packetHash: string;
  projectId: string;
  taskId: string;
  recipient: ContextPacket['recipient'];
  tokens: ContextPacket['tokens'];
  entries: InspectionEntry[];
}
const STAGES = ['retrieval', 'memory', 'packet'];

/**
 * Explain why each candidate reached or missed a verified packet. The report
 * holds references, reasons, token estimates and freshness only; it never
 * copies item content, so it is safe for diagnostics.
 */
export function inspectContext(input: {
  packet: ContextPacket;
  retrieval?: readonly { path: string; reason: OmissionReason }[];
  memory?: {
    assessed: readonly AssessedMemory[];
    excluded: readonly { id: string; reason: MemoryExclusion }[];
  };
}): ContextInspection {
  const { packet } = input;
  const packetHash = verifyContextPacket(packet);
  const freshness = new Map(
    (input.memory?.assessed ?? []).map((entry) => [
      entry.record.namespace + '#' + entry.record.id,
      entry,
    ]),
  );
  const byId = new Map(
    (input.memory?.assessed ?? []).map((entry) => [entry.record.id, entry]),
  );
  const annotate = (entry: AssessedMemory | undefined) =>
    entry
      ? {
          freshness: entry.freshness,
          ...(entry.changed.length ? { changed: [...entry.changed] } : {}),
        }
      : {};
  const entries: InspectionEntry[] = [
    ...(input.retrieval ?? []).map(({ path, reason }): InspectionEntry => ({
      stage: 'retrieval',
      ref: path,
      decision: 'omitted',
      reason,
    })),
    ...(input.memory?.excluded ?? []).map(({ id, reason }): InspectionEntry => {
      const assessed = byId.get(id);
      return {
        stage: 'memory',
        ref: assessed ? assessed.record.namespace + '#' + id : id,
        decision: 'omitted',
        reason,
        ...annotate(assessed),
      };
    }),
    ...packet.manifest.map((entry): InspectionEntry => ({
      stage: 'packet',
      ref: entry.ref,
      decision: entry.decision,
      reason: entry.reason,
      kind: entry.kind,
      tokens: entry.tokens,
      ...annotate(freshness.get(entry.ref)),
    })),
  ].sort(
    (a, b) =>
      STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) ||
      (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  );
  return {
    packetHash,
    projectId: packet.projectId,
    taskId: packet.taskId,
    recipient: { ...packet.recipient },
    tokens: { ...packet.tokens },
    entries,
  };
}
