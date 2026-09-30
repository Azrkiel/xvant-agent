import { verifyContextPacket } from '../../packages/context/src/packet.ts';

// Simulated second runtime: it sees only the sealed packet on stdin and
// proposes an edit. It verifies the seal first and never reads the workspace.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const packet = JSON.parse(input);
try {
  verifyContextPacket(packet);
} catch {
  console.error('packet seal rejected');
  process.exit(2);
}
const handoff = packet.items.find((item) => item.kind === 'handoff');
const match = handoff && /Set MAX_RETRIES to (\d+)/.exec(handoff.content);
if (!match) {
  console.error('handoff carries no continuation value');
  process.exit(3);
}
const file = packet.items.find(
  (item) => item.kind === 'file' && item.provenance.ref === 'src/fetch.ts',
);
if (!file || !file.content.includes('MAX_RETRIES = 0;')) {
  console.error('target file missing from packet');
  process.exit(4);
}
console.log(
  JSON.stringify({
    runtimeKind: 'simulated',
    edits: [
      {
        path: 'src/fetch.ts',
        baseHash: file.provenance.contentHash,
        find: 'MAX_RETRIES = 0;',
        replace: 'MAX_RETRIES = ' + match[1] + ';',
      },
    ],
  }),
);
