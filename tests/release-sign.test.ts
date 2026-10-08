import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, signFile, verifyFile } from '../scripts/release-sign.ts';

let dir: string;
const key = (name: string) => {
  const path = join(dir, name);
  const made = spawnSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', path],
    { encoding: 'utf8', windowsHide: true },
  );
  if (made.status !== 0) throw new Error('ssh-keygen: ' + made.stderr);
  return path;
};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'xvant-sign-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('a signature verifies only for the signed bytes and the signing key', () => {
  const signer = key('signer');
  const other = key('other');
  const sums = join(dir, 'SHA256SUMS');
  writeFileSync(sums, 'a'.repeat(64) + ' *xvant.zip\n');
  const signature = signFile(sums, signer);
  expect(signature).toBe(sums + '.sig');
  const publicKey = readFileSync(signer + '.pub', 'utf8');
  expect(verifyFile(sums, signature, publicKey)).toBe(true);
  expect(
    verifyFile(sums, signature, readFileSync(other + '.pub', 'utf8')),
  ).toBe(false);
  // Changing a checksum after signing is what the signature is for.
  appendFileSync(sums, 'b'.repeat(64) + ' *extra.zip\n');
  expect(verifyFile(sums, signature, publicKey)).toBe(false);
  expect(fingerprint(signer + '.pub')).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
});

it('reports a key that cannot sign', () => {
  const sums = join(dir, 'unsigned');
  writeFileSync(sums, 'x\n');
  expect(() => signFile(sums, join(dir, 'no-such-key'))).toThrow(/SIGN_FAILED/);
});
