import { execFile } from 'node:child_process';
import { z } from 'zod';
import { DomainError } from '../../contracts/src/index.ts';
import { revisionSchema } from '../../contracts/src/context.ts';
import {
  collectRepository,
  searchRepository,
  words,
} from '../../context/src/retrieval.ts';
import { containsSecret, secretPath } from '../../context/src/secrets.ts';
import { defineTool } from './registry.ts';
import { workspaceRoot } from './workspace.ts';

export const repoSearch = defineTool({
  manifest: {
    name: 'repo.search',
    version: '1.0.0',
    description:
      'Rank workspace files for a query and return matching lines. Ignored, secret, binary and linked files are excluded.',
    effect: 'read',
    permissions: ['workspace.read'],
    host: 'workspace',
    timeoutMs: 30_000,
    retry: 'safe',
    maxResultBytes: 512 * 1024,
  },
  input: z.strictObject({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(50).optional(),
    linesPerFile: z.number().int().min(1).max(20).optional(),
  }),
  output: z.strictObject({
    matches: z.array(
      z.strictObject({
        path: z.string(),
        score: z.number(),
        matched: z.array(z.string()),
        lines: z.array(z.strictObject({ line: z.number(), text: z.string() })),
      }),
    ),
  }),
  execute: async (input, context) => {
    const { files } = collectRepository(workspaceRoot(context));
    const byPath = new Map(files.map((file) => [file.path, file]));
    return {
      matches: searchRepository(files, input.query, {
        limit: input.limit ?? 10,
      }).map((result) => {
        const terms = new Set(result.matched);
        const lines = byPath
          .get(result.path)!
          .content.split('\n')
          .map((text, index) => ({ line: index + 1, text: text.trim() }))
          .filter(({ text }) => words(text).some((word) => terms.has(word)))
          .slice(0, input.linesPerFile ?? 5)
          .map(({ line, text }) => ({ line, text: text.slice(0, 300) }));
        return { ...result, lines };
      }),
    };
  },
});

const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
/**
 * Repository configuration can name programs (fsmonitor, external diff,
 * textconv) that git would execute. Inspection never runs repository code.
 */
function runGit(
  root: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
  );
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.pager=cat',
        '-c',
        'diff.external=',
        ...args,
      ],
      {
        cwd: root,
        env: { ...env, GIT_TERMINAL_PROMPT: '0' },
        signal,
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) =>
        error
          ? reject(new DomainError('TOOL_FAILED', 'git inspection failed'))
          : resolve(stdout),
    ),
  );
}
const hidden = (path: string) =>
  secretPath(path) ||
  path.split('/').some((segment) => segment.toLowerCase() === '.git');

export const gitInspect = defineTool({
  manifest: {
    name: 'git.inspect',
    version: '1.0.0',
    description:
      'Read git status, the working-tree diff, or head/base metadata. Never stages, commits, resets or cleans.',
    effect: 'read',
    permissions: ['workspace.read'],
    host: 'workspace',
    timeoutMs: 30_000,
    retry: 'safe',
    maxResultBytes: 2 * 1024 * 1024,
  },
  input: z.strictObject({
    mode: z.enum(['status', 'diff', 'base']),
    staged: z.boolean().optional(),
  }),
  output: z.union([
    z.strictObject({
      mode: z.literal('status'),
      head: revisionSchema.nullable(),
      entries: z.array(
        z.strictObject({ status: z.string(), path: z.string() }),
      ),
      omitted: z.array(
        z.strictObject({ path: z.string(), reason: z.literal('secret_path') }),
      ),
    }),
    z.strictObject({
      mode: z.literal('diff'),
      diff: z.string(),
      files: z.array(
        z.strictObject({
          path: z.string(),
          omitted: z.enum(['secret_path', 'secret_content']).optional(),
        }),
      ),
      truncated: z.boolean(),
    }),
    z.strictObject({
      mode: z.literal('base'),
      head: revisionSchema.nullable(),
      branch: z.string(),
      baseRevision: revisionSchema.nullable(),
      mergeBase: revisionSchema.nullable(),
      commitsSinceBase: z.number().int().nonnegative().nullable(),
    }),
  ]),
  execute: async (input, context, signal) => {
    const root = workspaceRoot(context);
    const git = (...args: string[]) => runGit(root, args, signal);
    const head = await git('rev-parse', '--verify', '-q', 'HEAD').then(
      (out) => out.trim() || null,
      () => null,
    );
    if (input.mode === 'status') {
      const entries: { status: string; path: string }[] = [];
      const omitted: { path: string; reason: 'secret_path' }[] = [];
      for (const record of (
        await git('status', '--porcelain=v1', '-z', '--untracked-files=all')
      )
        .split('\0')
        .filter(Boolean)) {
        const path = record.slice(3);
        if (hidden(path)) omitted.push({ path, reason: 'secret_path' });
        else entries.push({ status: record.slice(0, 2), path });
      }
      return { mode: 'status' as const, head, entries, omitted };
    }
    if (input.mode === 'diff') {
      const scope = input.staged ? ['--cached'] : [];
      const names = (
        await git('diff', ...scope, '--name-only', '-z', '--no-renames')
      )
        .split('\0')
        .filter(Boolean)
        .sort();
      const files: {
        path: string;
        omitted?: 'secret_path' | 'secret_content';
      }[] = [];
      const blocks: string[] = [];
      for (const path of names) {
        if (hidden(path)) {
          files.push({ path, omitted: 'secret_path' });
          continue;
        }
        const block = await git(
          'diff',
          ...scope,
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--',
          ':(literal)' + path,
        );
        if (containsSecret(block)) {
          files.push({ path, omitted: 'secret_content' });
          continue;
        }
        files.push({ path });
        blocks.push(block);
      }
      let diff = blocks.join('');
      const limit = 1024 * 1024;
      const truncated = Buffer.byteLength(diff) > limit;
      if (truncated) diff = Buffer.from(diff).subarray(0, limit).toString();
      return { mode: 'diff' as const, diff, files, truncated };
    }
    const branch = (
      await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')
    ).trim();
    const baseRevision = context.workspace?.baseRevision ?? null;
    if (
      baseRevision !== null &&
      !revisionSchema.safeParse(baseRevision).success
    )
      throw new DomainError('INVALID_INPUT', 'Invalid base revision');
    let mergeBase: string | null = null;
    let commitsSinceBase: number | null = null;
    if (baseRevision && head) {
      mergeBase =
        (
          await git('merge-base', 'HEAD', baseRevision).catch(() => '')
        ).trim() || null;
      const count = (
        await git('rev-list', '--count', baseRevision + '..HEAD').catch(
          () => '',
        )
      ).trim();
      commitsSinceBase = /^\d+$/.test(count) ? Number(count) : null;
    }
    return {
      mode: 'base' as const,
      head,
      branch,
      baseRevision,
      mergeBase,
      commitsSinceBase,
    };
  },
});
