import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../../contracts/src/index.ts';
import { relativePathSchema } from '../../contracts/src/context.ts';
import { safePath } from '../../storage/src/artifacts.ts';
import { secretPath } from '../../context/src/secrets.ts';
import type { ToolContext } from './registry.ts';

/** Is `path` one of the owned paths or inside an owned directory? */
export function owns(writablePaths: readonly string[], path: string): boolean {
  return writablePaths.some(
    (owned) => path === owned || path.startsWith(owned + '/'),
  );
}
export function workspaceRoot(context: ToolContext): string {
  const root = context.workspace?.root;
  if (!root)
    throw new DomainError(
      'CAPABILITY_UNSUPPORTED',
      'This task has no workspace',
    );
  if (realpathSync(root) !== root)
    throw new DomainError('PATH_DENIED', 'Workspace root is not canonical');
  return root;
}

/**
 * Map a worker-supplied repository path to an absolute path inside the
 * canonical workspace. Escapes, links in any component, VCS metadata and
 * secret-named files are denied; writes must also be inside owned paths.
 */
export function resolveWorkspacePath(
  context: ToolContext,
  path: string,
  mode: 'read' | 'write',
): string {
  const root = workspaceRoot(context);
  const deny = (reason: string): never => {
    throw new DomainError('PATH_DENIED', reason);
  };
  if (!relativePathSchema.safeParse(path).success)
    deny('Path must stay inside the workspace');
  if (path.split('/').some((segment) => segment.toLowerCase() === '.git'))
    deny('Repository metadata is not accessible');
  if (secretPath(path)) deny('Secret files are not accessible');
  if (mode === 'write' && !owns(context.workspace!.writablePaths, path))
    deny('Path is outside this task’s write ownership');
  const full = join(root, ...path.split('/'));
  try {
    return safePath(full);
  } catch {
    return deny('Links are not followed');
  }
}
