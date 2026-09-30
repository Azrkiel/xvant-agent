import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../storage/src/artifacts.ts';
import type { MemoryRecord } from '../../contracts/src/memory.ts';
import { memoryProposalSchema } from '../../contracts/src/memory.ts';
import {
  exportMemoryBundle,
  importExternalFile,
  importMemoryBundle,
  verifyMemoryBundle,
} from './transfer.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const TOKEN_SENTINEL = 'ghp_' + 'k9'.repeat(18);
function record(id: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  const content = extra.content ?? 'Memory ' + id;
  return {
    id,
    projectId: 'project',
    namespace: 'architecture',
    kind: 'fact',
    content,
    confidence: 'reported',
    provenance: { source: 'user', actorId: 'owner', revision: 'a'.repeat(40) },
    status: 'accepted',
    contentHash: sha(content),
    createdAt: 1,
    rowVersion: 1,
    ...extra,
  };
}
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-transfer-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('memory bundles', () => {
  it('exports accepted project records only and withholds credential-shaped content', () => {
    const { bundle, omitted } = exportMemoryBundle(
      [
        record('keep', {
          confidence: 'verified',
          provenance: { source: 'controller', actorId: 'xvant' },
          anchors: [{ path: 'src/a.ts', hash: sha('a') }],
        }),
        record('draft', { status: 'proposed' }),
        record('foreign', { projectId: 'other' }),
        record('leak', { content: 'token ' + TOKEN_SENTINEL }),
      ],
      { projectId: 'project', now: 42 },
    );
    expect(bundle).toMatchObject({
      version: 1,
      format: 'xvant-memory',
      projectId: 'project',
      exportedAt: 42,
    });
    expect(bundle.records.map((entry) => entry.id)).toEqual(['keep']);
    expect(bundle.records[0]).not.toHaveProperty('status');
    expect(omitted).toEqual([
      { id: 'draft', reason: 'not_accepted' },
      { id: 'foreign', reason: 'cross_project' },
      { id: 'leak', reason: 'secret_content' },
    ]);
    expect(JSON.stringify(bundle)).not.toContain(TOKEN_SENTINEL);
    expect(verifyMemoryBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(
      bundle,
    );
  });
  it('imports records only as unverified proposals attributed to the importer', () => {
    const { bundle } = exportMemoryBundle(
      [
        record('fact', {
          confidence: 'verified',
          provenance: { source: 'controller', actorId: 'xvant' },
        }),
        record('adr', { kind: 'decision', supersedes: 'older' }),
      ],
      { projectId: 'project', now: 1 },
    );
    const { proposals, skipped } = importMemoryBundle(bundle, {
      projectId: 'target',
      actorId: 'owner',
      revision: 'b'.repeat(40),
    });
    expect(skipped).toEqual([]);
    expect(proposals).toEqual([
      {
        id: 'fact',
        projectId: 'target',
        namespace: 'architecture',
        kind: 'fact',
        content: 'Memory fact',
        confidence: 'reported',
        provenance: {
          source: 'import',
          actorId: 'owner',
          revision: 'b'.repeat(40),
        },
      },
      {
        id: 'adr',
        projectId: 'target',
        namespace: 'architecture',
        kind: 'decision',
        content: 'Memory adr',
        confidence: 'reported',
        provenance: {
          source: 'import',
          actorId: 'owner',
          revision: 'b'.repeat(40),
        },
      },
    ]);
    for (const proposal of proposals)
      expect(memoryProposalSchema.safeParse(proposal).success).toBe(true);
  });
  it('keeps anchors so imported records can be checked for staleness', () => {
    const anchors = [{ path: 'src/a.ts', hash: sha('a') }];
    const { bundle } = exportMemoryBundle([record('m', { anchors })], {
      projectId: 'project',
      now: 1,
    });
    const [proposal] = importMemoryBundle(bundle, {
      projectId: 'project',
      actorId: 'owner',
    }).proposals;
    expect(proposal!.anchors).toEqual(anchors);
    expect(proposal!.provenance).toEqual({
      source: 'import',
      actorId: 'owner',
      revision: 'a'.repeat(40),
    });
  });
  it('rejects tampered bundles and skips secrets smuggled into a resealed one', () => {
    const { bundle } = exportMemoryBundle([record('m')], {
      projectId: 'project',
      now: 1,
    });
    const edited = JSON.parse(JSON.stringify(bundle));
    edited.records[0].content = 'Changed';
    expect(() => verifyMemoryBundle(edited)).toThrow('INVALID_EVIDENCE');
    edited.records[0].contentHash = sha('Changed');
    expect(() => verifyMemoryBundle(edited)).toThrow('INVALID_EVIDENCE');
    expect(() => verifyMemoryBundle({ format: 'other' })).toThrow(
      'INVALID_EVIDENCE',
    );
    const smuggled = exportMemoryBundle([record('ok')], {
      projectId: 'project',
      now: 1,
    }).bundle;
    const content = 'key ' + TOKEN_SENTINEL;
    const forged = JSON.parse(JSON.stringify(smuggled));
    forged.records.push({
      ...forged.records[0],
      id: 'bad',
      content,
      contentHash: sha(content),
    });
    const { bundleHash: _drop, ...body } = forged;
    void _drop;
    const resealed = { ...body, bundleHash: resealHash(body) };
    const result = importMemoryBundle(resealed, {
      projectId: 'project',
      actorId: 'owner',
    });
    expect(result.proposals.map((proposal) => proposal.id)).toEqual(['ok']);
    expect(result.skipped).toEqual([{ id: 'bad', reason: 'secret_content' }]);
  });
});

function resealHash(body: unknown): string {
  const canonical = JSON.stringify(body, (_key, child: unknown) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(
          Object.entries(child).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : child,
  );
  return sha(canonical);
}

describe('external file import', () => {
  it('copies a read-only vendor transcript into artifacts without modifying it', () => {
    const source = join(root, 'session.jsonl');
    writeFileSync(source, '{"role":"user","text":"hello"}\n');
    chmodSync(source, 0o444);
    const before = statSync(source);
    const objects = new ArtifactStore(join(root, 'objects'));
    const imported = importExternalFile(source, objects);
    expect(imported).toEqual({
      hash: sha('{"role":"user","text":"hello"}\n'),
      bytes: 31,
    });
    expect(objects.get(imported.hash).toString()).toBe(
      '{"role":"user","text":"hello"}\n',
    );
    const after = statSync(source);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode).toBe(before.mode);
    expect(readFileSync(source, 'utf8')).toBe(
      '{"role":"user","text":"hello"}\n',
    );
    chmodSync(source, 0o644);
  });
  it('refuses links, secrets, binary and oversized files', () => {
    const objects = new ArtifactStore(join(root, 'objects'));
    const target = join(root, 'real.txt');
    writeFileSync(target, 'text');
    symlinkSync(root, join(root, 'dir-link'), 'junction');
    expect(() =>
      importExternalFile(join(root, 'dir-link', 'real.txt'), objects),
    ).toThrow('UNSAFE_PATH');
    writeFileSync(join(root, 'secret.txt'), 'token ' + TOKEN_SENTINEL);
    expect(() => importExternalFile(join(root, 'secret.txt'), objects)).toThrow(
      'INVALID_INPUT',
    );
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
    expect(() => importExternalFile(join(root, 'bin.dat'), objects)).toThrow(
      'INVALID_INPUT',
    );
    expect(() => importExternalFile(target, objects, { maxBytes: 2 })).toThrow(
      'LIMIT_EXCEEDED',
    );
    expect(() => importExternalFile('relative.txt', objects)).toThrow(
      'INVALID_INPUT',
    );
  });
});
