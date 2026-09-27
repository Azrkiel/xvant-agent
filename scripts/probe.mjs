import { spawnSync } from 'node:child_process';
import { probeInventory } from './probe-policy.ts';
import { runOfflineRoster } from '../packages/adapters/src/providers/protocol.ts';

const args = process.argv.slice(2);
const mode = args[0];
const runtime = args[2];
if (
  args.length !== 3 ||
  !['--offline', '--inventory-only'].includes(mode) ||
  args[1] !== '--runtime' ||
  !['all', 'codex', 'claude', 'opencode'].includes(runtime)
) {
  console.error(
    'Usage: npm run probe -- --offline|--inventory-only --runtime all|codex|claude|opencode. Live/read-only execution is unavailable pending provider qualification; no model call was made.',
  );
  process.exit(2);
}
const kinds = runtime === 'all' ? ['codex', 'claude', 'opencode'] : [runtime];
if (mode === '--offline') {
  console.log(JSON.stringify(runOfflineRoster(kinds), null, 2));
} else {
  const report = probeInventory(kinds, (kind) => {
    const command = process.platform === 'win32' ? kind + '.exe' : kind;
    const child = spawnSync(command, ['--version'], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16384,
    });
    return {
      status: child.status,
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? '',
      errorCode: child.error?.code,
    };
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}
