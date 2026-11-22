import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hashSchema, idSchema } from '../../contracts/src/index.ts';
import { containsSecret } from '../../context/src/secrets.ts';
import type { ProcessResult, RunIdentity } from './index.ts';

const maxBytes = 128 * 1024;
const artifact = z.strictObject({
  version: z.literal(1),
  report: z.string().min(1).max(maxBytes),
});
export const workerReportBinding = z.strictObject({
  actionId: idSchema,
  inputHash: hashSchema,
  profileHash: hashSchema,
});

/** Accept a bounded report frame through the owned process handle, without opening a worker path. */
export function validateWorkerReport(
  result: ProcessResult,
  identity: RunIdentity,
  binding: z.infer<typeof workerReportBinding>,
) {
  if (
    result.identity.nonce !== identity.nonce ||
    result.identity.workerId !== identity.workerId ||
    result.identity.attemptId !== identity.attemptId ||
    result.identity.generation !== identity.generation ||
    result.reason !== 'exited' ||
    result.exitCode !== 0 ||
    result.outputTruncated ||
    Buffer.byteLength(result.stdout) > maxBytes ||
    result.stdout.includes('\ufffd')
  )
    throw new Error(
      'INVALID_WORKER_ARTIFACT: expected a complete bound report',
    );
  let frame: unknown;
  try {
    frame = JSON.parse(result.stdout);
  } catch {
    throw new Error('INVALID_WORKER_ARTIFACT: expected a JSON report');
  }
  const decoded = artifact.safeParse(frame);
  if (!decoded.success)
    throw new Error('INVALID_WORKER_ARTIFACT: unsupported report format');
  const { report } = decoded.data;
  if (
    Buffer.from(report).toString() !== report ||
    containsSecret(report) ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(report)
  )
    throw new Error('INVALID_WORKER_ARTIFACT: expected nonsecret text');
  const bytes = Buffer.from(report, 'utf8');
  return {
    bytes,
    receipt: {
      ...workerReportBinding.parse(binding),
      attemptId: identity.attemptId,
      workerId: identity.workerId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    },
  };
}
