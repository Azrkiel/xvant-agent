import assert from 'node:assert/strict';
import { renderTable } from '../src/report/table.js';

assert.equal(
  renderTable(['name', 'n'], [['alpha-service', 1], ['b', 22]]),
  ['name           n', '-------------  --', 'alpha-service  1', 'b              22'].join('\n'),
);
assert.equal(renderTable(['a'], []), 'a\n-');
