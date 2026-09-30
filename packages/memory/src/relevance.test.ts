import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { anchorFiles, assessMemory, memoryContextItems } from './relevance.ts';
import { buildContextPacket } from '../../context/src/packet.ts';
import type { MemoryRecord } from '../../contracts/src/memory.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const files = [
  { path: 'src/store.ts', hash: sha('store v2') },
  { path: 'src/api.ts', hash: sha('api v1') },
];
function record(id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  const content = extra.content ?? 'Record ' + id;
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

describe('memory freshness', () => {
  it('marks records stale when an anchored file changed or disappeared', () => {
    const assessed = assessMemory(
      [
        record('fresh', {
          anchors: [{ path: 'src/api.ts', hash: sha('api v1') }],
        }),
        record('changed', {
          anchors: [
            { path: 'src/api.ts', hash: sha('api v1') },
            { path: 'src/store.ts', hash: sha('store v1') },
          ],
        }),
        record('deleted', {
          anchors: [{ path: 'src/gone.ts', hash: sha('x') }],
        }),
        record('loose'),
      ],
      files,
    );
    expect(
      assessed.map(({ record, freshness, changed }) => [
        record.id,
        freshness,
        changed,
      ]),
    ).toEqual([
      ['fresh', 'current', []],
      ['changed', 'stale', ['src/store.ts']],
      ['deleted', 'stale', ['src/gone.ts']],
      ['loose', 'unanchored', []],
    ]);
  });
  it('anchors records to the current content of named files', () => {
    expect(anchorFiles(files, ['src/store.ts'])).toEqual([
      { path: 'src/store.ts', hash: sha('store v2') },
    ]);
    expect(() => anchorFiles(files, ['src/missing.ts'])).toThrow('NOT_FOUND');
    expect(() => anchorFiles(files, ['src/store.ts', 'src/store.ts'])).toThrow(
      'INVALID_INPUT',
    );
  });
});

describe('memory context items', () => {
  const convert = (records: MemoryRecord[]) =>
    memoryContextItems(assessMemory(records, files), 'project');
  it('includes accepted current knowledge and every tracked decision state', () => {
    const { items, excluded } = convert([
      record('fact', {
        confidence: 'verified',
        provenance: { source: 'controller', actorId: 'xvant' },
      }),
      record('rule', { kind: 'convention', confidence: 'inferred' }),
      record('adr', { kind: 'decision' }),
      record('adr-old', {
        kind: 'decision',
        status: 'superseded',
        supersededBy: 'adr',
      }),
      record('adr-new', { kind: 'decision', status: 'proposed' }),
      record('bug', { kind: 'failure' }),
      record('ask', { kind: 'question' }),
    ]);
    expect(excluded).toEqual([]);
    expect(
      items.map((item) => [
        item.provenance.ref,
        item.kind,
        item.decisionStatus,
        item.priority,
      ]),
    ).toEqual([
      ['architecture#fact', 'memory', undefined, 80],
      ['architecture#rule', 'memory', undefined, 40],
      ['architecture#adr', 'decision', 'accepted', 90],
      ['architecture#adr-old', 'decision', 'superseded', 10],
      ['architecture#adr-new', 'decision', 'proposed', 30],
      ['architecture#bug', 'failure', undefined, 60],
      ['architecture#ask', 'question', undefined, 60],
    ]);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items[0]).toMatchObject({
      required: false,
      content: 'Record fact',
      provenance: {
        source: 'memory',
        projectId: 'project',
        contentHash: sha('Record fact'),
      },
    });
  });
  it('excludes stale, unaccepted, rejected, and cross-project records with reasons', () => {
    const { items, excluded } = convert([
      record('stale', {
        anchors: [{ path: 'src/store.ts', hash: sha('store v1') }],
      }),
      record('draft', { status: 'proposed' }),
      record('old', { status: 'superseded', supersededBy: 'new' }),
      record('no', { status: 'rejected' }),
      record('no-adr', { kind: 'decision', status: 'rejected' }),
      record('stale-adr', {
        kind: 'decision',
        anchors: [{ path: 'src/gone.ts', hash: sha('x') }],
      }),
      record('foreign', { projectId: 'other' }),
    ]);
    expect(items).toEqual([]);
    expect(excluded).toEqual([
      { id: 'stale', reason: 'stale' },
      { id: 'draft', reason: 'unaccepted' },
      { id: 'old', reason: 'superseded' },
      { id: 'no', reason: 'rejected' },
      { id: 'no-adr', reason: 'rejected' },
      { id: 'stale-adr', reason: 'stale' },
      { id: 'foreign', reason: 'cross_project' },
    ]);
  });
  it('feeds the packet builder with sourced revisions', () => {
    const { items } = convert([
      record('adr', {
        kind: 'decision',
        provenance: {
          source: 'user',
          actorId: 'owner',
          revision: 'a'.repeat(40),
        },
      }),
    ]);
    const packet = buildContextPacket({
      projectId: 'project',
      taskId: 'task',
      objective: 'Continue the storage work',
      acceptanceCriteria: ['Tests pass'],
      baseRevision: 'a'.repeat(40),
      recipient: { workerId: 'claude-1', role: 'worker' },
      ownership: { writablePaths: [] },
      policy: { permissionProfile: 'trusted-local', allowedTools: [] },
      skills: [],
      budget: { maxTokens: 2048 },
      items,
    });
    expect(packet.items[0]).toMatchObject({
      kind: 'decision',
      decisionStatus: 'accepted',
      provenance: { revision: 'a'.repeat(40) },
    });
  });
});
