import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Binds a signature to this use, so a key's signature made elsewhere does not verify here. */
export const SIGNATURE_NAMESPACE = 'xvant-release';
const IDENTITY = 'xvant-release';

const sshKeygen = (args: string[], input?: Buffer) =>
  spawnSync('ssh-keygen', args, {
    ...(input ? { input } : {}),
    encoding: 'utf8',
    windowsHide: true,
  });

/**
 * Signs a file with an SSH private key and returns the path of the
 * detached signature beside it (`<file>.sig`). OpenSSH does the signing, so
 * the key may also live in an agent or on a hardware token.
 */
export function signFile(file: string, privateKey: string): string {
  rmSync(file + '.sig', { force: true });
  const result = sshKeygen([
    '-Y',
    'sign',
    '-f',
    privateKey,
    '-n',
    SIGNATURE_NAMESPACE,
    file,
  ]);
  if (result.error || result.status !== 0)
    throw new Error(
      'SIGN_FAILED: ' +
        (result.error?.message ?? result.stderr.trim() ?? 'ssh-keygen failed'),
    );
  return file + '.sig';
}

/** Whether `signature` is a valid signature of `file` by the holder of `publicKey` (one `ssh-ed25519 AAAA...` line). */
export function verifyFile(
  file: string,
  signature: string,
  publicKey: string,
): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'xvant-verify-'));
  try {
    const signers = join(dir, 'allowed_signers');
    writeFileSync(
      signers,
      IDENTITY +
        ' ' +
        publicKey.trim().split(/\s+/).slice(0, 2).join(' ') +
        '\n',
    );
    return (
      sshKeygen(
        [
          '-Y',
          'verify',
          '-f',
          signers,
          '-I',
          IDENTITY,
          '-n',
          SIGNATURE_NAMESPACE,
          '-s',
          signature,
        ],
        readFileSync(file),
      ).status === 0
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The SHA-256 fingerprint OpenSSH prints for a public key file, e.g. `SHA256:abc...`. */
export function fingerprint(publicKeyFile: string): string {
  const result = sshKeygen(['-l', '-E', 'sha256', '-f', publicKeyFile]);
  const match = /SHA256:\S+/.exec(result.stdout ?? '');
  if (!match) throw new Error('SIGN_FAILED: cannot read ' + publicKeyFile);
  return match[0];
}
