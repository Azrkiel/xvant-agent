import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Configuration } from './runner.ts';

interface Edit {
  path: string;
  content?: string;
  replacements?: { find: string; replace: string }[];
}
/**
 * Offline configurations for checking the harness itself. `reference`
 * applies each task's recorded solution; `noop` changes nothing. Neither
 * says anything about a model or runtime.
 */
export function referenceConfiguration(
  solutionFor: (taskId: string) => string,
): Configuration {
  return {
    versions: { runtime: 'reference-solution', model: 'none' },
    async run({ task, workspace }) {
      const { edits } = JSON.parse(
        readFileSync(solutionFor(task.id), 'utf8'),
      ) as { edits: Edit[] };
      for (const edit of edits) {
        const path = join(workspace, edit.path);
        let content = edit.content;
        if (content === undefined) {
          content = readFileSync(path, 'utf8');
          for (const { find, replace } of edit.replacements ?? []) {
            if (!content.includes(find))
              return { outcome: 'gave_up', reason: 'solution does not apply' };
            content = content.replace(find, () => replace);
          }
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      return {
        outcome: 'finished',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        toolFailures: 0,
        conflicts: 0,
      };
    },
  };
}
export const noopConfiguration: Configuration = {
  versions: { runtime: 'noop', model: 'none' },
  run: async () => ({
    outcome: 'finished',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolFailures: 0,
    conflicts: 0,
  }),
};
