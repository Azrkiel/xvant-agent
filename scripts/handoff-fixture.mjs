import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handoffFailures,
  runHandoffFixture,
} from '../apps/controller/src/handoff-fixture.ts';

// Codex-named worker hands off to a Claude-named simulated recipient. Not live G04.
const root = mkdtempSync(join(tmpdir(), 'xvant-handoff-fixture-'));
try {
  const report = await runHandoffFixture(root);
  const problems = handoffFailures(report);
  console.log(JSON.stringify({ ...report, problems }));
  if (problems.length) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
