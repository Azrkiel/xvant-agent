import { createHash } from 'node:crypto';
import { DomainError, parse } from '../../contracts/src/index.ts';
import {
  contextPacketInputSchema,
  contextPacketSchema,
} from '../../contracts/src/context.ts';
import type {
  ContextItem,
  ContextManifestEntry,
  ContextPacket,
  ContextPacketInput,
} from '../../contracts/src/context.ts';

/**
 * Conservative budget estimate: one token per three UTF-8 bytes, rounded up.
 * Typical tokenizers average more bytes per token, so this over-counts.
 * It is an estimate, never a provider-enforced limit.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}
/** JSON with recursively sorted keys, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : child,
  );
}
const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function hashPacket(packet: Omit<ContextPacket, 'packetHash'>): string {
  return sha256(canonicalJson(packet));
}
function contentMatches(item: ContextItem): boolean {
  return sha256(item.content) === item.provenance.contentHash;
}

/**
 * Build an immutable, hash-sealed context packet. The objective, acceptance
 * criteria, policy, and required items are never truncated: if they exceed the
 * budget the build fails so the caller splits the task or raises the budget.
 * Optional items are included whole, by priority, while they fit.
 */
export function buildContextPacket(input: ContextPacketInput): ContextPacket {
  const { budget, items, ...header } = parse(contextPacketInputSchema, input);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new DomainError('INVALID_INPUT', 'Duplicate context item identifier');
  if (!items.every(contentMatches))
    throw new DomainError(
      'INVALID_EVIDENCE',
      'Context item content does not match its recorded hash',
    );
  const ordered = [...items].sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      b.priority - a.priority ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const core = estimateTokens(canonicalJson(header));
  if (core > budget.maxTokens)
    throw new DomainError(
      'LIMIT_EXCEEDED',
      'Objective, criteria, and policy exceed the budget',
    );
  let used = core;
  const included: ContextItem[] = [];
  const manifest: ContextManifestEntry[] = [];
  for (const item of ordered) {
    const tokens = estimateTokens(canonicalJson(item));
    const entry = {
      id: item.id,
      kind: item.kind,
      ref: item.provenance.ref,
      tokens,
    };
    if (item.provenance.projectId !== header.projectId) {
      if (item.required)
        throw new DomainError(
          'INVALID_INPUT',
          'Required context belongs to another project',
        );
      manifest.push({ ...entry, decision: 'omitted', reason: 'cross_project' });
      continue;
    }
    if (used + tokens > budget.maxTokens) {
      if (item.required)
        throw new DomainError(
          'LIMIT_EXCEEDED',
          'Required context exceeds the budget; split the task or raise the budget',
        );
      manifest.push({ ...entry, decision: 'omitted', reason: 'budget' });
      continue;
    }
    used += tokens;
    included.push(item);
    manifest.push({
      ...entry,
      decision: 'included',
      reason: item.required ? 'required' : 'priority',
    });
  }
  const body = {
    version: 1 as const,
    ...header,
    items: included,
    manifest,
    tokens: {
      estimator: 'utf8-bytes-div-3' as const,
      budget: budget.maxTokens,
      core,
      used,
    },
  };
  return deepFreeze({ ...body, packetHash: hashPacket(body) });
}

/** Recompute a received packet's seal. Returns its hash or throws INVALID_EVIDENCE. */
export function verifyContextPacket(value: unknown): string {
  const result = contextPacketSchema.safeParse(value);
  if (!result.success)
    throw new DomainError('INVALID_EVIDENCE', 'Malformed context packet');
  const { packetHash, ...body } = result.data;
  if (hashPacket(body) !== packetHash || !body.items.every(contentMatches))
    throw new DomainError('INVALID_EVIDENCE', 'Context packet seal mismatch');
  return packetHash;
}
