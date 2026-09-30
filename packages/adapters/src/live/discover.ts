import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { LIVE_ROUTES, versionAccepted } from '../../../contracts/src/live.ts';
import type { ProviderKind } from '../../../contracts/src/providers.ts';

export interface DiscoveredRuntime {
  runtimeKind: ProviderKind;
  status: 'qualified' | 'version_mismatch' | 'unavailable' | 'failed';
  executable: string | null;
  version: string | null;
  expectedVersion: string;
  candidates: number;
}
const VERSION: Record<ProviderKind, RegExp> = {
  codex: /^codex-cli (\S+)$/,
  claude: /^(\S+) \(Claude Code\)$/,
  opencode: /^opencode v(\S+)$/,
};
const exe = (name: string) =>
  process.platform === 'win32' ? name + '.exe' : name;

/** Where each runtime is commonly installed, beyond PATH. Absolute paths only. */
export function candidatePaths(
  kind: ProviderKind,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const onPath = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter((dir) => dir && isAbsolute(dir));
  const found: string[] = [];
  const add = (path: string) => {
    if (isAbsolute(path) && existsSync(path) && !found.includes(path))
      found.push(path);
  };
  for (const dir of onPath) add(join(dir, exe(kind)));
  if (kind === 'codex') {
    const bin = join(local, 'OpenAI', 'Codex', 'bin');
    if (existsSync(bin))
      for (const entry of readdirSync(bin).sort())
        add(join(bin, entry, exe('codex')));
  }
  if (kind === 'claude') add(join(home, '.local', 'bin', exe('claude')));
  if (kind === 'opencode') {
    // npm installs a .cmd/.ps1 shim on PATH; the native binary sits beside it.
    for (const dir of onPath)
      for (const shim of ['opencode.cmd', 'opencode'])
        if (existsSync(join(dir, shim)))
          add(
            join(
              dir,
              'node_modules',
              '@opencode',
              'cli',
              'bin',
              exe('opencode'),
            ),
          );
  }
  return found.filter((path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

/** Resolve a runtime to one executable whose version matches its live route. */
export function discoverRuntime(
  kind: ProviderKind,
  options: { executable?: string; env?: NodeJS.ProcessEnv } = {},
): DiscoveredRuntime {
  const expectedVersion = LIVE_ROUTES[kind].runtimeVersion;
  const candidates = options.executable
    ? [resolve(options.executable)]
    : candidatePaths(kind, options.env);
  let first: DiscoveredRuntime | undefined;
  for (const executable of candidates) {
    const run = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 16384,
    });
    const match =
      run.status === 0 ? VERSION[kind].exec(run.stdout.trim()) : null;
    const result: DiscoveredRuntime = {
      runtimeKind: kind,
      status: !match
        ? 'failed'
        : versionAccepted(kind, match[1]!)
          ? 'qualified'
          : 'version_mismatch',
      executable,
      version: match?.[1] ?? null,
      expectedVersion,
      candidates: candidates.length,
    };
    if (result.status === 'qualified') return result;
    first ??= result;
  }
  return (
    first ?? {
      runtimeKind: kind,
      status: 'unavailable',
      executable: null,
      version: null,
      expectedVersion,
      candidates: 0,
    }
  );
}
