export function parse(argv) {
  const options = { verbose: false, dryRun: false, files: [] };
  for (const arg of argv) {
    if (arg === '--verbose') options.verbose = true;
    // Report planned writes without touching any file.
    else if (arg === '--dry-run') options.dryRun = true;
    else options.files.push(arg);
  }
  return options;
}
