#!/usr/bin/env node
import { main } from '../src/cli/cli.js';

process.exitCode = main(process.argv.slice(2), {
  out: (text) => console.log(text),
});
