import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveRun,
  bundleId,
  verifyBundle,
} from '../scripts/evidence-bundle.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const source = 'a'.repeat(64);
let root: string, runs: string;
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
function receipt(artifacts: { path: string; sha256: string }[]) {
  const file = join(root, 'docs/evidence/G05.json');
  writeFileSync(
    file,
    JSON.stringify({
      gateId: 'G05',
      status: 'passed',
      generatedAt: '2026-09-30T14:31:50.402Z',
      dirtyTreeHash: source,
      artifacts,
    }),
  );
  return file;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xvant-bundle-'));
  runs = join(root, 'docs/evidence/runs');
  mkdirSync(join(root, '.artifacts'), { recursive: true });
  mkdirSync(join(root, 'docs/evidence'), { recursive: true });
  writeFileSync(join(root, '.artifacts/tests.log'), 'ok');
});
afterEach(() => {
  for (const f of files(root)) chmodSync(f, 0o644);
  rmSync(root, { recursive: true, force: true });
});

describe('evidence bundles', () => {
  it('names a bundle by gate, time and source hash', () =>
    expect(
      bundleId('G05.json', {
        gateId: 'G05',
        generatedAt: '2026-09-30T14:31:50.402Z',
        dirtyTreeHash: source,
      }),
    ).toBe('G05-20260930T143150402Z-aaaaaaaaaaaa'));
  it('rejects receipts without a source hash', () =>
    expect(() =>
      bundleId('x.json', { generatedAt: '2026-09-30T00:00:00Z' }),
    ).toThrow());

  it('preserves declared bytes that later runs overwrite', () => {
    const file = receipt([{ path: '.artifacts/tests.log', sha256: sha('ok') }]);
    const made = archiveRun({
      receiptFile: file,
      sourceRoot: root,
      destination: runs,
    });
    expect(made.integrity).toBe('complete');
    writeFileSync(join(root, '.artifacts/tests.log'), 'next run');
    expect(verifyBundle(made.directory).problems).toEqual([]);
    expect(
      readFileSync(
        join(made.directory, 'artifacts/.artifacts/tests.log'),
        'utf8',
      ),
    ).toBe('ok');
  });

  it('records mismatched and missing artifacts instead of copying them', () => {
    const file = receipt([
      { path: '.artifacts/tests.log', sha256: sha('original') },
      { path: '.artifacts/gone.log', sha256: sha('x') },
    ]);
    const made = archiveRun({
      receiptFile: file,
      sourceRoot: root,
      destination: runs,
    });
    expect(made.integrity).toBe('partial');
    expect(made.artifacts.map((a) => a.status)).toEqual([
      'mismatch',
      'missing',
    ]);
    expect(verifyBundle(made.directory).problems).toEqual([]);
  });

  it('refuses to overwrite an existing bundle', () => {
    const file = receipt([]);
    archiveRun({ receiptFile: file, sourceRoot: root, destination: runs });
    expect(() =>
      archiveRun({ receiptFile: file, sourceRoot: root, destination: runs }),
    ).toThrow(/already exists/);
  });

  it('copies extra evidence directories with hashes', () => {
    mkdirSync(join(root, '.artifacts/live/objects'), { recursive: true });
    writeFileSync(join(root, '.artifacts/live/objects/abc'), 'blob');
    const made = archiveRun({
      receiptFile: receipt([]),
      sourceRoot: root,
      destination: runs,
      extras: ['.artifacts/live'],
    });
    expect(made.extras).toEqual([
      { path: '.artifacts/live/objects/abc', sha256: sha('blob') },
    ]);
    expect(verifyBundle(made.directory).problems).toEqual([]);
  });

  it('rejects artifact paths outside the source root', () => {
    const file = receipt([{ path: '../escape.log', sha256: sha('x') }]);
    expect(() =>
      archiveRun({ receiptFile: file, sourceRoot: root, destination: runs }),
    ).toThrow(/escapes/);
    expect(readdirSync(runs)).toEqual([]);
  });

  it('detects tampering after archival', () => {
    const file = receipt([{ path: '.artifacts/tests.log', sha256: sha('ok') }]);
    const made = archiveRun({
      receiptFile: file,
      sourceRoot: root,
      destination: runs,
    });
    const copy = join(made.directory, 'artifacts/.artifacts/tests.log');
    chmodSync(copy, 0o644);
    writeFileSync(copy, 'forged');
    expect(verifyBundle(made.directory).problems).toEqual(['altered ' + copy]);
  });
});
