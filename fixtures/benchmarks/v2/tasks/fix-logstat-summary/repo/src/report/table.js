// Renders a plain-text table: a header row, a dashed rule and one line per
// row. Every column is as wide as its widest cell, columns are separated by two
// spaces and lines carry no trailing spaces.
export function renderTable(headers, rows) {
  const widths = headers.map((header) => header.length);
  const line = (cells) =>
    cells
      .map((cell, i) => String(cell).padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [
    line(headers),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
  ].join('\n');
}
