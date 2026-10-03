// Release evidence check. Usage: npm run release:check -- --profile local-v1 [--json]
// Exits 0 only when every requirement of the profile is met by a passed
// receipt in an intact evidence bundle. It builds and publishes nothing.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sourceHash, verifyBundle } from './evidence-bundle.ts';
import { PROFILES, evaluateRelease } from './release-policy.ts';

const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
if (!args.includes('--profile') || !PROFILES.includes(profile)) {
  console.error(
    'Usage: npm run release:check -- --profile ' +
      PROFILES.join('|') +
      ' [--json]',
  );
  process.exit(2);
}
const root = resolve('.');
const evidence = join(root, 'docs', 'evidence');
const runs = join(evidence, 'runs');
// Receipt bytes -> state of the bundle that archived exactly those bytes.
const bundles = new Map();
for (const entry of existsSync(runs) ? readdirSync(runs) : []) {
  if (entry.endsWith('.partial')) continue;
  try {
    const { bundle, problems } = verifyBundle(join(runs, entry));
    // `partial`: the receipt passed but some declared artifacts were lost before archival.
    const state = problems.length
      ? 'tampered'
      : bundle.integrity === 'complete'
        ? 'intact'
        : 'partial';
    if (bundles.get(bundle.receipt.sha256) !== 'intact')
      bundles.set(bundle.receipt.sha256, state);
  } catch {
    /* An unreadable bundle backs nothing. */
  }
}
const receipts = {};
for (const file of existsSync(evidence) ? readdirSync(evidence) : []) {
  if (!file.endsWith('.json')) continue;
  try {
    const bytes = readFileSync(join(evidence, file));
    const receipt = JSON.parse(bytes.toString('utf8'));
    receipts[file.slice(0, -5)] = {
      status: String(receipt.status),
      sourceHash: receipt.dirtyTreeHash ?? receipt.sourceHash ?? null,
      bundle:
        bundles.get(createHash('sha256').update(bytes).digest('hex')) ??
        'missing',
      complete: receipt.complete,
      suiteShapeProblems: receipt.suiteShapeProblems,
      runtimes: Object.values(receipt.configurations ?? {}).map(
        (c) => c?.versions?.runtime,
      ),
    };
  } catch {
    /* An unreadable receipt is a missing receipt. */
  }
}
const result = evaluateRelease(profile, {
  receipts,
  currentSourceHash: sourceHash(root),
  deferred: {
    Linux: 'deferred by the operator; this release qualifies Windows only',
  },
});
if (args.includes('--json'))
  console.log(JSON.stringify({ profile, ...result }, null, 2));
else {
  for (const r of result.requirements)
    console.log(r.state.toUpperCase().padEnd(9) + r.id.padEnd(30) + r.detail);
  const unmet = result.requirements.filter((r) => r.state === 'unmet').length;
  console.log(
    profile +
      ': ' +
      (result.ready ? 'ready' : 'NOT ready, ' + unmet + ' unmet'),
  );
}
process.exitCode = result.ready ? 0 : 1;
