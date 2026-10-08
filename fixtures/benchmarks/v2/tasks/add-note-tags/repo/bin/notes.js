#!/usr/bin/env node
import { main } from '../src/cli/cli.js';

const file = process.env.NOTES_FILE ?? 'notes.json';
process.exitCode = main(process.argv.slice(2), {
  file,
  out: (line) => console.log(line),
});
