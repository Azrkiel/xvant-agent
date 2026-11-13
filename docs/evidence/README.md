# Verification evidence

A00 records fixture qualification only. The [runner guide](../autonomy/a00-runner.md)
explains the setup. The [A00 handoff](a00/handoff.md) maps acceptance criteria to
observations and records limits. Linux and Windows need independent receipts.

## Durable records

The `a00/` directory contains reviewed receipts, setup diagnostics, and compressed
copies of immutable evidence bundles. Each archive contains `bundle.json`, its
exact `receipt.json`, and the artifacts declared by that receipt. Failed receipts
are retained alongside passing ones. `a00/SHA256SUMS` covers the archives.

Git-tracked evidence persists with repository history and is the durable record.
GitHub Actions artifacts are convenient full downloads, retained for 30 days;
run/job URLs remain useful provenance after downloadable artifacts expire, but
are not a substitute for the checked-in bytes. Promote a reviewed receipt and
bundle before artifact expiry when qualifying a milestone. Never overwrite an
archived bundle or reinterpret a failed run as a pass.

## Verify retained bytes

From the repository root on Linux:

```sh
sha256sum -c docs/evidence/a00/SHA256SUMS
mkdir -p .artifacts/retained
for archive in docs/evidence/a00/*.tar.gz; do
  tar -xzf "$archive" -C .artifacts/retained
done
node --input-type=module -e 'import {readdirSync} from "node:fs"; import {verifyBundle} from "./scripts/evidence-bundle.ts"; for (const name of readdirSync(".artifacts/retained")) { const {bundle,problems}=verifyBundle(".artifacts/retained/"+name); console.log(name,bundle.receipt.status,bundle.integrity,problems); if(problems.length || bundle.integrity!=="complete") process.exitCode=1; }'
```

Integrity says whether recorded bytes were preserved, not whether verification
passed. Check each receipt's status, source revision, source manifest, commands,
platform, runtime, and limits. `dirtyTreeHash` inventories all indexed and
nonignored files except `docs/evidence/`; Git revision and content hash have
different purposes. CI validates both against the actual checked-out source.

Only allowlisted fixture logs, test JSON, coverage summaries, source manifests,
and receipts belong in ordinary CI artifacts. Do not upload `.env`, credential
files, homes, SQLite databases, browser profiles, signing keys, live transcripts,
or the complete runner environment. Live qualification has separate authorization
and disclosure requirements.
