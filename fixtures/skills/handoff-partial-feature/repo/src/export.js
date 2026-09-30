import { toCsv } from './csv.js';

export function exportRows(rows) {
  // TODO(handoff): stream large exports instead of building one string.
  return toCsv(rows);
}
