// Splits arguments into positional words and `--name value` options.
export function parseArgs(argv, options) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!options.includes(name)) throw new TypeError('unknown option: ' + arg);
    if (i + 1 >= argv.length) throw new TypeError('option needs a value: ' + arg);
    i += 1;
    flags[name] = argv[i];
  }
  return { positional, flags };
}
