import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillCatalog } from '../packages/skills/src/catalog.ts';
import { compatibilityMatrix } from '../packages/skills/src/compatibility.ts';
import { fileApplyPatch, fileRead } from '../packages/tools/src/files.ts';
import { gitInspect, repoSearch } from '../packages/tools/src/repository.ts';
import { createProcessTools } from '../packages/tools/src/process.ts';
import { createControllerTools } from '../packages/tools/src/controller.ts';

// Manifests only: services are used at execution time, which never happens here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = [
  fileRead,
  fileApplyPatch,
  repoSearch,
  gitInspect,
  ...createProcessTools({ supervisor: {}, testCommands: [] }),
  ...createControllerTools({ store: {}, objects: {} }),
].map(({ manifest }) => ({ name: manifest.name, effect: manifest.effect }));
const rows = compatibilityMatrix({
  catalog: loadSkillCatalog(join(root, 'skills')),
  tools,
  profiles: ['read-only', 'trusted-local'],
});
const counts = {};
for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
console.log(
  JSON.stringify({ classification: 'offline', tools, counts, rows }, null, 2),
);
