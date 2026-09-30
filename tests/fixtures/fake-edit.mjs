// Deterministic stand-in for a model following the live roster's
// instructions. Used by synthetic peers only.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** @returns 'edited' | 'hang' | 'unmatched' */
export function followInstruction(prompt, cwd = process.cwd()) {
  const create =
    /Create a file named (\S+?\.txt) .*single line: (.+?)\. Do not/.exec(
      prompt,
    );
  if (create) {
    writeFileSync(join(cwd, create[1]), create[2] + '\n');
    return 'edited';
  }
  const append =
    /In (\S+?\.txt), keep the existing line and add a second line: (.+?)\. Do not/.exec(
      prompt,
    );
  if (append) {
    const file = join(cwd, append[1]);
    const current = readFileSync(file, 'utf8');
    appendFileSync(
      file,
      (current.endsWith('\n') ? '' : '\n') + append[2] + '\n',
    );
    return 'edited';
  }
  if (/Create 40 files/.test(prompt)) return 'hang';
  return 'unmatched';
}
