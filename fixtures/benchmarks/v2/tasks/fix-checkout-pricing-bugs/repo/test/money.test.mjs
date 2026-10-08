import assert from 'node:assert/strict';
import { formatMoney, fromCents, toCents } from '../src/pricing/money.js';

assert.equal(toCents(19.99), 1999);
assert.equal(toCents(0.57), 57);
assert.equal(toCents(5), 500);
assert.equal(fromCents(1999), 19.99);
assert.equal(formatMoney(1999), '$19.99');
assert.equal(formatMoney(-5), '-$0.05');
