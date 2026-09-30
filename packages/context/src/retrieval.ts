import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../contracts/src/index.ts';
import { relativePathSchema } from '../../contracts/src/context.ts';
import type { ContextItem } from '../../contracts/src/context.ts';
import { safePath } from '../../storage/src/artifacts.ts';

export interface RepositoryFile {
  path: string;
  bytes: number;
  hash: string;
  content: string;
}
export type OmissionReason =
  | 'secret_path'
  | 'secret_content'
  | 'binary'
  | 'too_large'
  | 'unsafe_path'
  | 'not_file'
  | 'missing'
  | 'changed'
  | 'limit';
export interface RepositoryCollection {
  source: 'git' | 'walk';
  files: RepositoryFile[];
  omitted: { path: string; reason: OmissionReason }[];
}
const optionsSchema = z.strictObject({
  maxFileBytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 * 1024)
    .default(256 * 1024),
  maxFiles: z.number().int().min(1).max(20000).default(5000),
  maxTotalBytes: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024 * 1024)
    .default(16 * 1024 * 1024),
});
/** Listing bound applied before per-file limits; beyond it retrieval refuses. */
const MAX_LISTED = 100_000;
const SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules']);
const SECRET_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg']);
const SECRET_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
  'credentials.json',
  'secrets.json',
  'terraform.tfstate',
]);
/** Name-based exclusion runs before any read, so these files never enter memory. */
function secretPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const name = segments.at(-1)!;
  return (
    segments.some((segment) => SECRET_SEGMENTS.has(segment)) ||
    SECRET_NAMES.has(name) ||
    (/^\.env(?:\.|$)/.test(name) &&
      !/\.(?:example|sample|template)$/.test(name)) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|gpg|asc)$/.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name)
  );
}
/** Defense in depth: known credential shapes. Absence does not prove a file is secret-free. */
const SECRET_CONTENT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
  );
}
/**
 * Git's own ignore semantics; undefined when the root is not in a readable
 * work tree. Repository config can name an fsmonitor program that ls-files
 * would execute, so it is disabled: listing must never run repository code.
 */
function listGit(root: string): string[] | undefined {
  let output: Buffer;
  try {
    output = execFileSync(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ],
      {
        cwd: root,
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
    );
  } catch {
    return undefined;
  }
  return [...new Set(output.toString('utf8').split('\0').filter(Boolean))];
}
function walk(
  root: string,
  omitted: RepositoryCollection['omitted'],
): string[] {
  const paths: string[] = [];
  const pending: string[] = [''];
  while (pending.length) {
    const relative = pending.pop()!;
    const directory = relative ? join(root, ...relative.split('/')) : root;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) omitted.push({ path, reason: 'unsafe_path' });
      else if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else paths.push(path);
      if (paths.length + pending.length > MAX_LISTED)
        throw new DomainError('LIMIT_EXCEEDED', 'Repository listing too large');
    }
  }
  return paths;
}
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function readRegular(path: string, size: number): Buffer | 'changed' {
  const before = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== size
    )
      return 'changed';
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    return length === size ? buffer.subarray(0, length) : 'changed';
  } finally {
    closeSync(fd);
  }
}
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Read-only, bounded collection of text files under a canonical root. Ignore
 * rules come from Git when available; secret-named files are never read;
 * links and multiply-linked files are refused rather than followed.
 */
export function collectRepository(
  root: string,
  options: z.input<typeof optionsSchema> = {},
): RepositoryCollection {
  const parsed = optionsSchema.safeParse(options);
  if (!isAbsolute(root) || !parsed.success)
    throw new DomainError('INVALID_INPUT', 'Invalid repository request');
  const limits = parsed.data;
  const absolute = safePath(root);
  if (realpathSync(absolute) !== absolute || !lstatSync(absolute).isDirectory())
    throw new DomainError(
      'INVALID_INPUT',
      'Root must be a canonical directory',
    );
  const omitted: RepositoryCollection['omitted'] = [];
  const listed = listGit(absolute);
  const paths = (listed ?? walk(absolute, omitted)).sort(byPath);
  if (paths.length > MAX_LISTED)
    throw new DomainError('LIMIT_EXCEEDED', 'Repository listing too large');
  const files: RepositoryFile[] = [];
  let total = 0;
  const omit = (path: string, reason: OmissionReason) =>
    omitted.push({ path, reason });
  for (const path of paths) {
    if (files.length >= limits.maxFiles) {
      omit(path, 'limit');
      continue;
    }
    if (!relativePathSchema.safeParse(path).success) {
      omit(path, 'unsafe_path');
      continue;
    }
    if (secretPath(path)) {
      omit(path, 'secret_path');
      continue;
    }
    const full = join(absolute, ...path.split('/'));
    let stat;
    try {
      safePath(full);
      stat = lstatSync(full);
    } catch (error) {
      omit(
        path,
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing'
          : 'unsafe_path',
      );
      continue;
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
      omit(path, 'unsafe_path');
      continue;
    }
    if (!stat.isFile()) {
      omit(path, 'not_file');
      continue;
    }
    if (stat.size > limits.maxFileBytes) {
      omit(path, 'too_large');
      continue;
    }
    if (total + stat.size > limits.maxTotalBytes) {
      omit(path, 'limit');
      continue;
    }
    const bytes = readRegular(full, stat.size);
    if (bytes === 'changed') {
      omit(path, 'changed');
      continue;
    }
    let content: string;
    try {
      if (bytes.includes(0)) throw new Error('binary');
      content = utf8.decode(bytes);
    } catch {
      omit(path, 'binary');
      continue;
    }
    if (SECRET_CONTENT.some((pattern) => pattern.test(content))) {
      omit(path, 'secret_content');
      continue;
    }
    total += bytes.length;
    files.push({
      path,
      bytes: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'),
      content,
    });
  }
  omitted.sort((a, b) => byPath(a.path, b.path));
  return { source: listed ? 'git' : 'walk', files, omitted };
}

/** Lowercase identifier words, including camelCase and snake_case parts. */
function words(text: string): string[] {
  const out: string[] = [];
  for (const token of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
    out.push(token.toLowerCase());
    const parts = token
      .split(/_+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u)
      .filter(Boolean);
    if (parts.length > 1)
      for (const part of parts) out.push(part.toLowerCase());
  }
  return out;
}
export interface SearchResult {
  path: string;
  score: number;
  matched: string[];
}
/**
 * Rank files with SQLite FTS5 BM25, weighting path and symbol words above body
 * text. Query text is reduced to quoted words, so FTS syntax is inert.
 */
export function searchRepository(
  files: readonly RepositoryFile[],
  query: string,
  options: { limit?: number } = {},
): SearchResult[] {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new DomainError('INVALID_INPUT', 'Invalid search limit');
  const terms = [...new Set(words(query))]
    .filter((term) => term.length >= 2)
    .slice(0, 32);
  if (!terms.length || !files.length) return [];
  const db = new Database(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(path, body)');
    const insert = db.prepare(
      'INSERT INTO docs(rowid, path, body) VALUES (?, ?, ?)',
    );
    db.transaction(() =>
      files.forEach((file, index) =>
        insert.run(
          index + 1,
          words(file.path).join(' '),
          words(file.content).join(' '),
        ),
      ),
    )();
    const rows = db
      .prepare(
        `SELECT rowid AS id, bm25(docs, 5.0, 1.0) AS rank FROM docs
         WHERE docs MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(terms.map((term) => '"' + term + '"').join(' OR '), limit) as {
      id: number;
      rank: number;
    }[];
    return rows
      .map(({ id, rank }) => {
        const file = files[id - 1]!;
        const present = new Set([...words(file.path), ...words(file.content)]);
        return {
          path: file.path,
          score: -rank,
          matched: terms.filter((term) => present.has(term)).sort(),
        };
      })
      .sort((a, b) => b.score - a.score || byPath(a.path, b.path));
  } finally {
    db.close();
  }
}

/** Turn ranked files into sourced, optional context items; top result gets priority 100. */
export function repositoryContextItems(input: {
  projectId: string;
  revision: string;
  files: readonly RepositoryFile[];
  results: readonly SearchResult[];
}): ContextItem[] {
  const byName = new Map(input.files.map((file) => [file.path, file]));
  const top = input.results[0]?.score ?? 0;
  return input.results.map((result) => {
    const file = byName.get(result.path);
    if (!file) throw new DomainError('NOT_FOUND', 'Search result has no file');
    return {
      id:
        'file_' +
        createHash('sha256').update(file.path).digest('hex').slice(0, 16),
      kind: 'file',
      required: false,
      priority:
        top > 0
          ? Math.min(100, Math.max(1, Math.round((100 * result.score) / top)))
          : 1,
      content: file.content,
      provenance: {
        source: 'repository',
        projectId: input.projectId,
        ref: file.path,
        contentHash: file.hash,
        revision: input.revision,
      },
    };
  });
}
