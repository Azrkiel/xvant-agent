import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (path) => import(pathToFileURL(resolve(path)).href);
const { toCents, fromCents, formatMoney } = await load('src/pricing/money.js');
const { applyDiscounts, discountCents } = await load('src/pricing/discount.js');
const { taxCents } = await load('src/pricing/tax.js');
const { createStock } = await load('src/inventory/stock.js');
const { createCart } = await load('src/cart/cart.js');
const { checkout } = await load('src/checkout/order.js');

// 1. money rounding
assert.equal(toCents(19.99), 1999);
assert.equal(toCents(0.57), 57);
assert.equal(toCents(0.29), 29);
assert.equal(toCents(1234.56), 123456);
assert.equal(toCents(5), 500);
assert.equal(fromCents(1999), 19.99);
assert.equal(formatMoney(1999), '$19.99');
assert.throws(() => toCents('1'), TypeError);

// 2. discounts are capped at the subtotal and add up
assert.equal(applyDiscounts(1000, [{ type: 'fixed', cents: 1500 }]), 0);
assert.equal(discountCents(1000, [{ type: 'fixed', cents: 1500 }]), 1000);
assert.equal(applyDiscounts(1000, [{ type: 'fixed', cents: 800 }, { type: 'percent', value: 50 }]), 0);
assert.equal(applyDiscounts(1000, [{ type: 'percent', value: 10 }, { type: 'percent', value: 10 }]), 800);
assert.equal(applyDiscounts(1000, [{ type: 'fixed', cents: 250 }]), 750);
assert.equal(applyDiscounts(1000), 1000);
assert.equal(applyDiscounts(0, [{ type: 'fixed', cents: 100 }]), 0);

// 3. the last unit can be reserved
const stock = createStock({ a: 3 });
stock.reserve('a', 3);
assert.equal(stock.available('a'), 0);
assert.throws(() => stock.reserve('a', 1), RangeError);
const small = createStock({ b: 2 });
assert.throws(() => small.reserve('b', 3), RangeError);
assert.equal(small.available('b'), 2);
small.reserve('b', 1);
small.reserve('b', 1);
assert.equal(small.available('b'), 0);
assert.throws(() => small.reserve('missing', 1), RangeError);

// 4. tax is rounded to the nearest cent
assert.equal(taxCents(1999, 0.0825), 165);
assert.equal(taxCents(1000, 0.1), 100);
assert.equal(taxCents(333, 0.07), 23);
assert.equal(taxCents(0, 0.0825), 0);

// the pieces together
const cart = createCart();
cart.add('a', 3, toCents(19.99));
const order = checkout(cart, createStock({ a: 3 }), {
  discounts: [{ type: 'percent', value: 10 }],
  taxRate: 0.0825,
  weightGrams: 800,
});
assert.equal(order.subtotalCents, 5997);
assert.equal(order.discountedCents, 5397);
assert.equal(order.taxCents, 445);
assert.equal(order.shippingCents, 899);
assert.equal(order.totalCents, 6741);
