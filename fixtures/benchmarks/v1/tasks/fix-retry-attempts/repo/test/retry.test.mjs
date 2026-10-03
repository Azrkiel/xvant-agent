import assert from 'node:assert/strict';
import { retry } from '../src/retry.js';
let calls = 0;
const flaky = async () => {
  calls += 1;
  if (calls < 3) throw new Error('fail ' + calls);
  return 'ok';
};
assert.equal(await retry(flaky, 3), 'ok');
assert.equal(calls, 3);
let failures = 0;
await assert.rejects(
  retry(async () => {
    failures += 1;
    throw new Error('fail ' + failures);
  }, 2),
  /fail 2/,
);
assert.equal(failures, 2);
