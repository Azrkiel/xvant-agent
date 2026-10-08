import assert from 'node:assert/strict';
import { createStock } from '../src/inventory/stock.js';

const stock = createStock({ a: 3 });
stock.reserve('a', 2);
assert.equal(stock.available('a'), 1);
stock.reserve('a', 1);
assert.equal(stock.available('a'), 0);
assert.throws(() => stock.reserve('a', 1), RangeError);
assert.throws(() => createStock({ b: 1 }).reserve('b', 2), RangeError);
