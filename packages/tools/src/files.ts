import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { DomainError, hashSchema } from '../../contracts/src/index.ts';
import { readRegular } from '../../context/src/retrieval.ts';
import { containsSecret } from '../../context/src/secrets.ts';
import { defineTool } from './registry.ts';
import { resolveWorkspacePath } from './workspace.ts';

const MAX_FILE_BYTES = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const digest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
/** Current bytes of a regular, singly linked file, or undefined when absent. */
function currentBytes(full: string): Buffer | undefined {
  let stat;
  try {
    stat = lstatSync(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new DomainError('PATH_DENIED', 'Not a regular file');
  if (stat.size > MAX_FILE_BYTES)
    throw new DomainError('LIMIT_EXCEEDED', 'File is too large');
  const bytes = readRegular(full, stat.size);
  if (bytes === 'changed')
    throw new DomainError('CONFLICT', 'File changed while it was read');
  return bytes;
}
function text(bytes: Buffer): string {
  try {
    if (bytes.includes(0)) throw new Error('binary');
    return utf8.decode(bytes);
  } catch {
    throw new DomainError('INVALID_INPUT', 'File is not UTF-8 text');
  }
}
const lineNumber = z.number().int().min(1).max(10_000_000);

export const fileRead = defineTool({
  manifest: {
    name: 'file.read',
    version: '1.0.0',
    description:
      'Read a line range of a UTF-8 text file inside the workspace, with the whole-file hash.',
    effect: 'read',
    permissions: ['workspace.read'],
    host: 'workspace',
    timeoutMs: 10_000,
    retry: 'safe',
    maxResultBytes: 8 * 1024 * 1024,
  },
  input: z.strictObject({
    path: z.string().min(1).max(1024),
    startLine: lineNumber.optional(),
    endLine: lineNumber.optional(),
  }),
  output: z.strictObject({
    path: z.string(),
    hash: hashSchema,
    totalLines: z.number().int().nonnegative(),
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    content: z.string(),
  }),
  execute: async (input, context) => {
    const full = resolveWorkspacePath(context, input.path, 'read');
    const bytes = currentBytes(full);
    if (!bytes) throw new DomainError('NOT_FOUND', 'File not found');
    const content = text(bytes);
    if (containsSecret(content))
      throw new DomainError(
        'PATH_DENIED',
        'File contains credential-shaped content',
      );
    const lines = content.split('\n');
    if (content.endsWith('\n')) lines.pop();
    const startLine = input.startLine ?? 1;
    const endLine = Math.min(input.endLine ?? lines.length, lines.length);
    if (lines.length && (startLine > lines.length || endLine < startLine))
      throw new DomainError('INVALID_INPUT', 'Line range is outside the file');
    return {
      path: input.path,
      hash: digest(bytes),
      totalLines: lines.length,
      startLine: lines.length ? startLine : 0,
      endLine: lines.length ? endLine : 0,
      content: lines.slice(startLine - 1, endLine).join('\n'),
    };
  },
});

const path = z.string().min(1).max(1024);
const editSchema = z.union([
  z.strictObject({
    path,
    expectedHash: hashSchema.nullable(),
    content: z.string().max(MAX_FILE_BYTES),
  }),
  z.strictObject({
    path,
    expectedHash: hashSchema,
    replacements: z
      .array(
        z.strictObject({
          find: z.string().min(1).max(100_000),
          replace: z.string().max(100_000),
        }),
      )
      .min(1)
      .max(64),
  }),
  z.strictObject({ path, expectedHash: hashSchema, delete: z.literal(true) }),
]);
type Edit = z.infer<typeof editSchema>;
function planned(edit: Edit, current: Buffer | undefined): string | null {
  const before = current ? digest(current) : null;
  if (before !== edit.expectedHash)
    throw new DomainError(
      'STALE_EVIDENCE',
      'File does not match the expected hash',
    );
  if ('delete' in edit) return null;
  if ('content' in edit) return edit.content;
  let next = text(current!);
  for (const { find, replace } of edit.replacements) {
    if (next.split(find).length !== 2)
      throw new DomainError(
        'CONFLICT',
        'Each replacement must match exactly once',
      );
    next = next.replace(find, () => replace);
  }
  return next;
}

export const fileApplyPatch = defineTool({
  manifest: {
    name: 'file.apply_patch',
    version: '1.0.0',
    description:
      'Write, replace in, or delete owned workspace files. Every edit states the hash it was based on; the whole patch is checked before anything is written.',
    effect: 'workspace-write',
    permissions: ['workspace.write'],
    host: 'workspace',
    timeoutMs: 30_000,
    retry: 'unsafe',
    maxResultBytes: 64 * 1024,
  },
  input: z.strictObject({ edits: z.array(editSchema).min(1).max(32) }),
  output: z.strictObject({
    files: z.array(
      z.strictObject({
        path: z.string(),
        before: hashSchema.nullable(),
        after: hashSchema.nullable(),
      }),
    ),
  }),
  execute: async (input, context) => {
    if (
      new Set(input.edits.map((edit) => edit.path)).size !== input.edits.length
    )
      throw new DomainError('INVALID_INPUT', 'Each path may appear once');
    const plan = input.edits.map((edit) => {
      const full = resolveWorkspacePath(context, edit.path, 'write');
      const current = currentBytes(full);
      return { edit, full, current, next: planned(edit, current) };
    });
    // Re-check right before writing so a concurrent change is not overwritten.
    for (const step of plan) {
      const now = currentBytes(step.full);
      if ((now ? digest(now) : null) !== step.edit.expectedHash)
        throw new DomainError('CONFLICT', 'File changed during the patch');
    }
    for (const { edit, full, next } of plan) {
      if (next === null) {
        unlinkSync(full);
        continue;
      }
      mkdirSync(dirname(full), { recursive: true });
      // New directories must not have become links before the write.
      resolveWorkspacePath(context, edit.path, 'write');
      const temp = join(
        dirname(full),
        '.' + basename(full) + '.' + randomUUID() + '.tmp',
      );
      writeFileSync(temp, next, { flag: 'wx' });
      renameSync(temp, full);
    }
    return {
      files: plan.map(({ edit, current, next }) => ({
        path: edit.path,
        before: current ? digest(current) : null,
        after: next === null ? null : digest(next),
      })),
    };
  },
});
