import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runToolsFixture,
  toolsFailures,
} from '../apps/controller/src/tools-fixture.ts';

// Hostile simulated worker behind the MCP bridge. Offline G05 boundary check.
const root = mkdtempSync(join(tmpdir(), 'xvant-tools-fixture-'));
try {
  const report = await runToolsFixture(root);
  const problems = toolsFailures(report);
  console.log(JSON.stringify({ ...report, problems }));
  if (problems.length) process.exitCode = 1;
} finally {
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
