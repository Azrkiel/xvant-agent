import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import {
  buildContextPacket,
  estimateTokens,
  verifyContextPacket,
} from './packet.ts';
import type { ContextPacketInput } from '../../contracts/src/context.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function item(
  id: string,
  content: string,
  extra: Partial<ContextPacketInput['items'][number]> = {},
) {
  return {
    id,
    kind: 'file' as const,
    required: false,
    priority: 50,
    content,
    provenance: {
      source: 'repository' as const,
      projectId: 'project',
      ref: 'src/' + id + '.ts',
      contentHash: sha(content),
    },
    ...extra,
  };
}
function input(
  overrides: Partial<ContextPacketInput> = {},
): ContextPacketInput {
  return {
    projectId: 'project',
    taskId: 'task',
    objective: 'Add a retry limit to the fetch helper',
    acceptanceCriteria: ['Retries stop after three attempts', 'Tests pass'],
    baseRevision: 'a'.repeat(40),
    recipient: { workerId: 'codex-1', role: 'worker' },
    ownership: { writablePaths: ['src/fetch.ts'] },
    policy: {
      permissionProfile: 'trusted-local',
      allowedTools: ['file.read', 'repo.search'],
    },
    skills: [
      { id: 'implement-change', version: '1.0.0', hash: 'b'.repeat(64) },
    ],
    budget: { maxTokens: 4096 },
    items: [item('fetch', 'export const fetch = () => 1;')],
    ...overrides,
  };
}
function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return (
    Object.isFrozen(value) &&
    Object.values(value as object).every((child) => deepFrozen(child))
  );
}

describe('context packet', () => {
  it('keeps the objective and criteria verbatim and seals the packet', () => {
    const packet = buildContextPacket(input());
    expect(packet.version).toBe(1);
    expect(packet.objective).toBe('Add a retry limit to the fetch helper');
    expect(packet.acceptanceCriteria).toEqual([
      'Retries stop after three attempts',
      'Tests pass',
    ]);
    expect(packet.items.map((entry) => entry.id)).toEqual(['fetch']);
    expect(packet.packetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyContextPacket(packet)).toBe(packet.packetHash);
    expect(deepFrozen(packet)).toBe(true);
  });
  it('is deterministic regardless of candidate order', () => {
    const items = [item('a', 'alpha'), item('b', 'beta'), item('c', 'gamma')];
    const first = buildContextPacket(input({ items }));
    const second = buildContextPacket(input({ items: [...items].reverse() }));
    expect(second.packetHash).toBe(first.packetHash);
    expect(second.manifest).toEqual(first.manifest);
  });
  it('includes required items first, then whole items by priority within budget', () => {
    const big = 'x'.repeat(3000);
    const packet = buildContextPacket(
      input({
        budget: { maxTokens: 2000 },
        items: [
          item('low', 'low priority', { priority: 1 }),
          item('need', big, { required: true, priority: 0 }),
          item('high', 'y'.repeat(2400), { priority: 90 }),
          item('mid', 'medium', { priority: 40 }),
        ],
      }),
    );
    const decisions = Object.fromEntries(
      packet.manifest.map((entry) => [entry.id, entry.reason]),
    );
    expect(decisions).toEqual({
      need: 'required',
      high: 'budget',
      mid: 'priority',
      low: 'priority',
    });
    expect(packet.items.map((entry) => entry.id)).toEqual([
      'need',
      'mid',
      'low',
    ]);
    expect(packet.items[0]!.content).toBe(big);
    expect(packet.tokens.used).toBeLessThanOrEqual(packet.tokens.budget);
    expect(packet.tokens.estimator).toBe('utf8-bytes-div-3');
  });
  it('refuses to truncate when required context exceeds the budget', () => {
    expect(() =>
      buildContextPacket(
        input({
          budget: { maxTokens: 256 },
          items: [item('need', 'z'.repeat(2000), { required: true })],
        }),
      ),
    ).toThrow('LIMIT_EXCEEDED');
    expect(() =>
      buildContextPacket(
        input({
          budget: { maxTokens: 256 },
          acceptanceCriteria: ['c'.repeat(2000)],
          items: [],
        }),
      ),
    ).toThrow('LIMIT_EXCEEDED');
  });
  it('rejects items whose content does not match the recorded hash', () => {
    const forged = { ...item('a', 'original'), content: 'changed' };
    expect(() => buildContextPacket(input({ items: [forged] }))).toThrow(
      'INVALID_EVIDENCE',
    );
  });
  it('omits cross-project records visibly and refuses required ones', () => {
    const foreign = item('foreign', 'other project secret plan', {
      provenance: {
        source: 'memory',
        projectId: 'other',
        ref: 'memory-1',
        contentHash: sha('other project secret plan'),
      },
    });
    const packet = buildContextPacket(input({ items: [foreign] }));
    expect(packet.items).toEqual([]);
    expect(packet.manifest).toEqual([
      expect.objectContaining({
        id: 'foreign',
        decision: 'omitted',
        reason: 'cross_project',
      }),
    ]);
    expect(JSON.stringify(packet)).not.toContain('other project secret plan');
    expect(() =>
      buildContextPacket(input({ items: [{ ...foreign, required: true }] })),
    ).toThrow('INVALID_INPUT');
  });
  it.each([
    ['duplicate item ids', { items: [item('a', 'one'), item('a', 'two')] }],
    ['parent path', { ownership: { writablePaths: ['../escape.ts'] } }],
    ['absolute path', { ownership: { writablePaths: ['/etc/passwd'] } }],
    ['drive path', { ownership: { writablePaths: ['C:\\Windows'] } }],
    ['backslash path', { ownership: { writablePaths: ['src\\a.ts'] } }],
    [
      'decision without status',
      { items: [item('d', 'use sqlite', { kind: 'decision' })] },
    ],
    [
      'status on a non-decision',
      { items: [item('f', 'file', { decisionStatus: 'accepted' })] },
    ],
    ['empty criteria', { acceptanceCriteria: [] }],
    ['bad revision', { baseRevision: 'HEAD' }],
    ['tiny budget', { budget: { maxTokens: 10 } }],
    [
      'bad tool name',
      { policy: { permissionProfile: 'p', allowedTools: ['rm -rf'] } },
    ],
  ] as const)('rejects %s', (_name, overrides) => {
    expect(() =>
      buildContextPacket(input(overrides as Partial<ContextPacketInput>)),
    ).toThrow('INVALID_INPUT');
  });
  it('detects tampering after construction', () => {
    const packet = buildContextPacket(input());
    const copy = JSON.parse(JSON.stringify(packet));
    copy.acceptanceCriteria = ['Anything goes'];
    expect(() => verifyContextPacket(copy)).toThrow('INVALID_EVIDENCE');
    const rehashed = { ...copy, packetHash: 'c'.repeat(64) };
    expect(() => verifyContextPacket(rehashed)).toThrow('INVALID_EVIDENCE');
    expect(() => verifyContextPacket({ version: 2 })).toThrow(
      'INVALID_EVIDENCE',
    );
  });
  it('keeps decision status and provenance on included items', () => {
    const decision = item('d1', 'Use SQLite FTS5 before embeddings', {
      kind: 'decision',
      decisionStatus: 'accepted',
      provenance: {
        source: 'memory',
        projectId: 'project',
        ref: 'decision-1',
        contentHash: sha('Use SQLite FTS5 before embeddings'),
        revision: 'f'.repeat(40),
      },
    });
    const [included] = buildContextPacket(input({ items: [decision] })).items;
    expect(included).toEqual(decision);
  });
  it('holds budget and inclusion invariants for arbitrary candidates', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            id: fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/),
            text: fc.string({ minLength: 1, maxLength: 800 }),
            priority: fc.integer({ min: 0, max: 100 }),
            required: fc.boolean(),
          }),
          { selector: (entry) => entry.id, maxLength: 12 },
        ),
        fc.integer({ min: 256, max: 4000 }),
        (candidates, maxTokens) => {
          const items = candidates.map((entry) =>
            item(entry.id, entry.text, {
              priority: entry.priority,
              required: entry.required,
            }),
          );
          let packet;
          try {
            packet = buildContextPacket(
              input({ items, budget: { maxTokens } }),
            );
          } catch (error) {
            expect(String(error)).toContain('LIMIT_EXCEEDED');
            return;
          }
          expect(packet.tokens.used).toBeLessThanOrEqual(maxTokens);
          const included = new Set(packet.items.map((entry) => entry.id));
          for (const entry of candidates)
            if (entry.required) expect(included.has(entry.id)).toBe(true);
          expect(packet.manifest.map((entry) => entry.id).sort()).toEqual(
            candidates.map((entry) => entry.id).sort(),
          );
          expect(verifyContextPacket(packet)).toBe(packet.packetHash);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('token estimate', () => {
  it('overestimates from UTF-8 bytes instead of characters', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('€€')).toBe(2);
  });
});
