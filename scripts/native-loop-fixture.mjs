import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nativeFailures,
  runNativeFixture,
} from '../apps/controller/src/native-loop-fixture.ts';

// XVANT's own loop against a hostile model over loopback HTTP, a restart,
// and every skill fixture with a deterministic model. Offline G08.
const root = mkdtempSync(join(tmpdir(), 'xvant-native-loop-'));
try {
  const report = await runNativeFixture(root);
  const problems = nativeFailures(report);
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
