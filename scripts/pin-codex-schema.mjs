// Offline export only; this script does not launch a provider.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const [directory, runtimeVersion] = process.argv.slice(2);
if (
  !directory ||
  runtimeVersion !== '0.158.0-alpha.2.1' ||
  process.argv.length !== 4
)
  throw new Error(
    'Usage: node scripts/pin-codex-schema.mjs EXPORT_DIRECTORY 0.158.0-alpha.2.1',
  );
const files = [
  'v1/InitializeParams',
  'v1/InitializeResponse',
  'v2/TurnStartParams',
  'v2/TurnStartResponse',
  'v2/TurnInterruptParams',
  'v2/TurnInterruptResponse',
  'v2/TurnStartedNotification',
  'v2/TurnCompletedNotification',
  'v2/AgentMessageDeltaNotification',
  'CommandExecutionRequestApprovalParams',
  'CommandExecutionRequestApprovalResponse',
  'FileChangeRequestApprovalParams',
  'FileChangeRequestApprovalResponse',
  'v2/ThreadStartParams',
  'v2/ThreadStartResponse',
  'v2/ThreadResumeParams',
  'v2/ThreadResumeResponse',
  'v2/ThreadStartedNotification',
  'v2/ErrorNotification',
];
const bundle = { runtimeVersion, sources: [], definitions: {}, schemas: {} };
for (const file of files) {
  const bytes = readFileSync(resolve(directory, file + '.json'));
  const schema = JSON.parse(bytes);
  bundle.sources.push({
    file: file + '.json',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  for (const [name, definition] of Object.entries(schema.definitions ?? {})) {
    if (
      Object.hasOwn(bundle.definitions, name) &&
      JSON.stringify(bundle.definitions[name]) !== JSON.stringify(definition)
    )
      throw new Error('Conflicting generated definition: ' + name);
    bundle.definitions[name] = definition;
  }
  delete schema.definitions;
  bundle.schemas[file.split('/').at(-1)] = schema;
}
writeFileSync(
  new URL('../packages/adapters/src/codex/schema.json', import.meta.url),
  JSON.stringify(bundle, null, 2) + '\n',
);
console.log(
  'Pinned ' + files.length + ' schema roots for Codex ' + runtimeVersion,
);
