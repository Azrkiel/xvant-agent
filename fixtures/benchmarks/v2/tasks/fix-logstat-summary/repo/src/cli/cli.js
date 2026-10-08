import { readFileSync } from 'node:fs';
import { summarize } from '../aggregate/summary.js';
import { parseLog } from '../parse/line.js';
import { renderSummary } from '../report/render.js';
import { parseArgs } from './args.js';

// logstat summary <file> [--level LEVEL] [--service NAME]
// Prints one row per hour and service and returns the exit code.
export function main(argv, { out, readFile = (path) => readFileSync(path, 'utf8') }) {
  try {
    const [command, ...rest] = argv;
    if (command !== 'summary') {
      out('usage: logstat summary <file> [--level LEVEL] [--service NAME]');
      return 1;
    }
    const { positional, flags } = parseArgs(rest, ['level', 'service']);
    if (positional.length !== 1) throw new TypeError('expected one log file');
    let entries = parseLog(readFile(positional[0]));
    if (flags.level !== undefined)
      entries = entries.filter((entry) => entry.level === flags.level);
    if (flags.service !== undefined)
      entries = entries.filter((entry) => entry.service === flags.service);
    out(renderSummary(summarize(entries)));
    return 0;
  } catch (error) {
    out('error: ' + error.message);
    return 1;
  }
}
