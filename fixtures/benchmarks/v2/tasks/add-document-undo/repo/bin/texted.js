#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from '../src/cli/repl.js';

run(readFileSync(0, 'utf8'), { out: (line) => console.log(line) });
