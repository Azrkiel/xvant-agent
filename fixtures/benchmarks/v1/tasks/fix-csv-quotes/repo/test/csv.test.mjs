import assert from 'node:assert/strict';
import { parseLine } from '../src/csv.js';
assert.deepEqual(parseLine('a, b,c'), ['a', 'b', 'c']);
assert.deepEqual(parseLine('"x, y",z'), ['x, y', 'z']);
