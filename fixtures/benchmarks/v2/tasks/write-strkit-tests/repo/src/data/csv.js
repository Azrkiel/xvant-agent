// Parses CSV text into an array of rows of strings. A field may be wrapped in
// double quotes to contain the delimiter or line breaks, and "" inside quotes
// is one quote. Rows end at \n or \r\n; a final line break does not add an
// empty row. Throws a SyntaxError when a quoted field is never closed.
export function parseCsv(text, { delimiter = ',' } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') continue;
    else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new SyntaxError('unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
