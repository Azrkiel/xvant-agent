// Splits arguments into positional words and flags. A flag listed in
// `valueFlags` takes the next argument (or `--name=value`) as its value.
export function parseArgs(argv, valueFlags = []) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2);
    if (!valueFlags.includes(name)) throw new TypeError('unknown option: ' + arg);
    const value = inline ?? argv[(i += 1)];
    if (value === undefined) throw new TypeError('option needs a value: ' + arg);
    flags[name] = value;
  }
  return { positional, flags };
}
