import { parseCsv } from './csv.js';

// Tab-separated values: the same rules as CSV with a tab as the delimiter.
export const parseTsv = (text) => parseCsv(text, { delimiter: '\t' });
