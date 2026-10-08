#!/usr/bin/env node
import { main } from '../src/cli/cli.js';

main(
  process.argv.slice(2),
  {
    dir: process.env.ACCOUNTS_DIR ?? 'data',
    out: (line) => console.log(line),
  },
  (code) => {
    process.exitCode = code;
  },
);
