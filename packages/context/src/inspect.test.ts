import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildContextPacket } from './packet.ts';
import { inspectContext } from './inspect.ts';
import {
  assessMemory,
  memoryContextItems,
} from '../../memory/src/relevance.ts';
import type { MemoryRecord } from '../../contracts/src/memory.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const SECRET_BODY = 'confidential design ' + 'x'.repeat(8);
function record(id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  const content = extra.content ?? 'Memory ' + id;
  return {
    id,
    projectId: 'project',
    namespace: 'architecture',
    kind: 'fact',
    content,
    confidence: 'reported',
    provenance: { source: 'user', actorId: 'owner' },
    status: 'accepted',
    contentHash: sha(content),
    createdAt: 1,
    rowVersion: 1,
    ...extra,
  };
}

describe('context inspection', () => {
  it('explains every retrieval, memory and packet decision without content', () => {
    const files = [{ path: 'src/a.ts', hash: sha('a2') }];
    const assessed = assessMemory(
      [
        record('kept'),
        record('anchored', {
          anchors: [{ path: 'src/a.ts', hash: sha('a2') }],
        }),
        record('old', {
          content: SECRET_BODY,
          anchors: [{ path: 'src/a.ts', hash: sha('a1') }],
        }),
      ],
      files,
    );
    const memory = memoryContextItems(assessed, 'project');
    const file = {
      id: 'file_a',
      kind: 'file' as const,
      required: false,
      priority: 1,
      content: 'y'.repeat(6000),
      provenance: {
        source: 'repository' as const,
        projectId: 'project',
        ref: 'src/big.ts',
        contentHash: sha('y'.repeat(6000)),
      },
    };
    const packet = buildContextPacket({
      projectId: 'project',
      taskId: 'task',
      objective: 'Objective',
      acceptanceCriteria: ['Criterion'],
      baseRevision: 'a'.repeat(40),
      recipient: { workerId: 'claude-1', role: 'worker' },
      ownership: { writablePaths: [] },
      policy: { permissionProfile: 'trusted-local', allowedTools: [] },
      skills: [],
      budget: { maxTokens: 1024 },
      items: [...memory.items, file],
    });
    const report = inspectContext({
      packet,
      retrieval: [
        { path: '.env', reason: 'secret_path' },
        { path: 'img.png', reason: 'binary' },
      ],
      memory: { assessed, excluded: memory.excluded },
    });
    expect(report).toMatchObject({
      packetHash: packet.packetHash,
      projectId: 'project',
      taskId: 'task',
      recipient: { workerId: 'claude-1', role: 'worker' },
      tokens: packet.tokens,
    });
    expect(
      report.entries.map(({ stage, ref, decision, reason }) => [
        stage,
        ref,
        decision,
        reason,
      ]),
    ).toEqual([
      ['retrieval', '.env', 'omitted', 'secret_path'],
      ['retrieval', 'img.png', 'omitted', 'binary'],
      ['memory', 'architecture#old', 'omitted', 'stale'],
      ['packet', 'architecture#anchored', 'included', 'priority'],
      ['packet', 'architecture#kept', 'included', 'priority'],
      ['packet', 'src/big.ts', 'omitted', 'budget'],
    ]);
    expect(report.entries[2]).toMatchObject({ changed: ['src/a.ts'] });
    expect(report.entries[3]).toMatchObject({ freshness: 'current' });
    expect(report.entries[4]).toMatchObject({ freshness: 'unanchored' });
    expect(report.entries[5]!.tokens).toBeGreaterThan(1000);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SECRET_BODY);
    expect(serialized).not.toContain('Memory kept');
  });
  it('refuses to describe a packet whose seal does not verify', () => {
    const packet = buildContextPacket({
      projectId: 'project',
      taskId: 'task',
      objective: 'Objective',
      acceptanceCriteria: ['Criterion'],
      baseRevision: 'a'.repeat(40),
      recipient: { workerId: 'claude-1', role: 'worker' },
      ownership: { writablePaths: [] },
      policy: { permissionProfile: 'trusted-local', allowedTools: [] },
      skills: [],
      budget: { maxTokens: 1024 },
      items: [],
    });
    expect(() =>
      inspectContext({ packet: { ...packet, taskId: 'other' } }),
    ).toThrow('INVALID_EVIDENCE');
  });
});
