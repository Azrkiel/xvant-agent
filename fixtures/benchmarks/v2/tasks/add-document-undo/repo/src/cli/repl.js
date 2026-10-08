import { createDocument } from '../core/document.js';
import { renderLines } from '../io/render.js';
import { parseCommandLine } from './parse.js';

// Runs a script, one command per line, and returns the document.
export function run(script, { out, document = createDocument() }) {
  for (const raw of script.split('\n')) {
    if (!raw.trim()) continue;
    const { name, number, text } = parseCommandLine(raw);
    try {
      switch (name) {
        case 'insert':
          document.insert(number, text);
          break;
        case 'delete':
          document.delete(number);
          break;
        case 'replace':
          document.replace(number, text);
          break;
        case 'print':
          for (const line of renderLines(document.lines())) out(line);
          break;
        default:
          out('error: unknown command: ' + name);
      }
    } catch (error) {
      out('error: ' + error.message);
    }
  }
  return document;
}
