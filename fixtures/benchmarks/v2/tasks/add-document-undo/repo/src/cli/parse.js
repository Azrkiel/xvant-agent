// "insert 2 some text" becomes { name: 'insert', number: 2, text: 'some text' }.
// `number` is undefined and `text` is '' when absent.
export function parseCommandLine(line) {
  const match = /^(\S+)(?:\s+(\d+))?(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return { name: '', number: undefined, text: '' };
  return {
    name: match[1].toLowerCase(),
    number: match[2] === undefined ? undefined : Number(match[2]),
    text: match[3] ?? '',
  };
}
