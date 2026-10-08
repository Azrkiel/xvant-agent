import { renderTable } from './table.js';

const HEADERS = ['hour', 'service', 'count', 'errors', 'p50', 'p95'];

export function renderSummary(rows) {
  return renderTable(
    HEADERS,
    rows.map((row) => HEADERS.map((name) => row[name])),
  );
}
