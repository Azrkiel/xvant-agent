import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveRun, verifyBundle } from './evidence-bundle.ts';

const runs = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs/evidence/runs',
);
const args = process.argv.slice(2);
const usage =
  'Usage: node scripts/archive-evidence.mjs --verify | --receipt FILE --root SOURCE_ROOT [--extra PATH]...';

if (args.length === 1 && args[0] === '--verify') {
  let failed = 0;
  for (const entry of existsSync(runs) ? readdirSync(runs).sort() : []) {
    if (entry.endsWith('.partial')) {
      console.log(entry + ': INCOMPLETE staging directory');
      failed++;
      continue;
    }
    const { bundle, problems } = verifyBundle(join(runs, entry));
    failed += problems.length ? 1 : 0;
    console.log(
      [
        entry,
        'receipt=' + bundle.receipt.status,
        'artifacts=' + bundle.integrity,
        problems.length ? 'TAMPERED ' + problems.join('; ') : 'intact',
      ].join('  '),
    );
  }
  process.exit(failed ? 1 : 0);
}

let receiptFile, sourceRoot;
const extras = [];
for (let i = 0; i < args.length; i += 2) {
  const value = args[i + 1];
  if (!value) break;
  if (args[i] === '--receipt') receiptFile = value;
  else if (args[i] === '--root') sourceRoot = value;
  else if (args[i] === '--extra') extras.push(value);
  else receiptFile = undefined;
}
if (!receiptFile || !sourceRoot || args.length % 2) {
  console.error(usage);
  process.exit(2);
}
const bundle = archiveRun({
  receiptFile,
  sourceRoot,
  destination: runs,
  extras,
});
console.log(
  JSON.stringify(
    {
      bundleId: bundle.bundleId,
      integrity: bundle.integrity,
      artifacts: bundle.artifacts.filter((a) => a.status !== 'preserved'),
      extras: bundle.extras.length,
    },
    null,
    2,
  ),
);
