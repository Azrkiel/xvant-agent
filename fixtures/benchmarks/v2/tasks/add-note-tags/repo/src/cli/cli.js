import { parseNote } from '../parse/line.js';
import { createStore } from '../store/store.js';
import { parseArgs } from './args.js';
import { formatNote } from './format.js';

// Runs one command and returns the exit code.
export function main(argv, { file, out }) {
  const [command, ...rest] = argv;
  const store = createStore(file);
  try {
    switch (command) {
      case 'add': {
        const saved = store.add(parseNote(rest.join(' ')));
        out('added ' + saved.id);
        return 0;
      }
      case 'list': {
        parseArgs(rest);
        for (const note of store.list()) out(formatNote(note));
        return 0;
      }
      case 'done':
      case 'rm': {
        const id = Number(rest[0]);
        const ok = command === 'done' ? store.setDone(id) : store.remove(id);
        if (!ok) throw new RangeError('no such note: ' + rest[0]);
        out(command === 'done' ? 'done ' + id : 'removed ' + id);
        return 0;
      }
      default:
        out('usage: notes <add|list|done|rm> ...');
        return 1;
    }
  } catch (error) {
    out('error: ' + error.message);
    return 1;
  }
}
