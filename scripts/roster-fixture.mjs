import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rosterFailures,
  runControllerRoster,
} from '../apps/controller/src/offline-roster.ts';

// Ten named synthetic workers through the owned controllers. Not live G03.
const root = mkdtempSync(join(tmpdir(), 'xvant-roster-fixture-'));
try {
  const report = await runControllerRoster(root);
  const problems = rosterFailures(report);
  console.log(
    JSON.stringify({
      classification: report.classification,
      liveProvidersTested: report.liveProvidersTested,
      workers: report.results.length,
      results: report.results.map((result) => ({
        workerId: result.workerId,
        scenario: result.scenario,
        state: result.state,
        outcome: result.outcome,
        failure: result.failure,
      })),
      blocked: report.blocked,
      activeCount: report.activeCount,
      accepted: report.accepted,
      problems,
    }),
  );
  if (problems.length) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
