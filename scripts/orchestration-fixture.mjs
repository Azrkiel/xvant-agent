import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestrationFixture } from '../apps/controller/src/orchestration-fixture.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'xvant-orchestration-')));
try {
  console.log(JSON.stringify(await runOrchestrationFixture(root), null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
