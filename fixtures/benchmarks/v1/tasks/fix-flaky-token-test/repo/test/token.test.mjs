import assert from 'node:assert/strict';
import { issue, isValid } from '../src/token.js';
const token = issue(5);
assert.equal(isValid(token), true);
const start = Date.now();
while (Date.now() - start < Math.random() * 10) {
  // wait
}
assert.equal(isValid(token), false);
