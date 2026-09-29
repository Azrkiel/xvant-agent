// Read declarations as data only; never import or execute downloaded SDK code.
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [directory] = process.argv.slice(2);
if (!directory || process.argv.length !== 3)
  throw new Error(
    'Usage: node scripts/pin-provider-types.mjs ARTIFACT_DIRECTORY',
  );
const specs = {
  claude: {
    package: '@anthropic-ai/claude-agent-sdk',
    version: '0.3.283',
    archive: 'anthropic-ai-claude-agent-sdk-0.3.283.tgz',
    integrity:
      'sha512-KB+mqU5JLbH2sztlSQeCOu71bK6padYAha3uacBzxFSOVfuRTywYzvsC9P+qV6gXmPXcu98FaPqQv6vBF9j8hA==',
    directory: 'claude-sdk/package',
    file: 'sdk.d.ts',
    roots: [
      'SDKResultSuccess',
      'SDKResultError',
      'SDKControlPermissionRequest',
      'SDKControlRequest',
      'SDKControlResponse',
      'ControlResponse',
      'SDKUserMessage',
      'SDKControlInitializeRequest',
      'SDKControlInitializeResponse',
      'SDKSystemMessage',
      'SDKControlInterruptRequest',
      'SDKControlInterruptResponse',
    ],
  },
  opencode: {
    package: '@opencode-ai/sdk',
    version: '1.18.33',
    archive: 'opencode-ai-sdk-1.18.33.tgz',
    integrity:
      'sha512-Nyurky9+AA2tvZ6my8UtO5pxPoXxrNypqjeEqMshBGiR542glOy+KE1Y+3lwWU+Z6HC/hSmrdXNbX81+qiuTzg==',
    directory: 'opencode-sdk/package',
    file: 'dist/v2/gen/types.gen.d.ts',
    roots: [
      'AssistantMessage',
      'EventMessageUpdated',
      'EventSessionError',
      'EventSessionIdle',
      'EventPermissionAsked',
      'PermissionReplyData',
      'SessionAbortData',
      'SessionAbortResponses',
      'SessionGetData',
      'SessionGetResponses',
      'SessionCreateData',
      'SessionCreateResponses',
      'PermissionRule',
      'Session',
    ],
  },
};
const pins = {};
for (const [kind, spec] of Object.entries(specs)) {
  const archive = readFileSync(resolve(directory, spec.archive));
  if (
    'sha512-' + createHash('sha512').update(archive).digest('base64') !==
    spec.integrity
  )
    throw new Error('ARCHIVE_INTEGRITY');
  const extract = (file) =>
    execFileSync(
      'tar',
      ['-xOf', resolve(directory, spec.archive), 'package/' + file],
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
  const pkg = JSON.parse(extract('package.json').toString('utf8'));
  if (pkg.name !== spec.package || pkg.version !== spec.version)
    throw new Error('VERSION_UNSUPPORTED');
  const bytes = extract(spec.file);
  const source = ts.createSourceFile(
    spec.file,
    bytes.toString('utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = {};
  for (const node of source.statements) {
    if (
      !ts.isTypeAliasDeclaration(node) ||
      !spec.roots.includes(node.name.text)
    )
      continue;
    if (!ts.isTypeLiteralNode(node.type))
      throw new Error('UNSUPPORTED_DECLARATION');
    declarations[node.name.text] = node.type.members
      .filter(ts.isPropertySignature)
      .map((member) => ({
        name: member.name.getText(source),
        required: !member.questionToken,
      }));
  }
  if (Object.keys(declarations).length !== spec.roots.length)
    throw new Error('MISSING_DECLARATION');
  pins[kind] = {
    package: spec.package,
    version: spec.version,
    integrity: spec.integrity,
    file: spec.file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    declarations,
  };
}
writeFileSync(
  new URL(
    '../packages/adapters/src/providers/native-pins.json',
    import.meta.url,
  ),
  JSON.stringify(pins, null, 2) + '\n',
);
console.log(
  'Pinned supported declaration surfaces for Claude and OpenCode; not a full SDK schema.',
);
