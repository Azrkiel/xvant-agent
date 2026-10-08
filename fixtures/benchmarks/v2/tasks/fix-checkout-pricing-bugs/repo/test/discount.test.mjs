import assert from 'node:assert/strict';
import { applyDiscounts, discountCents } from '../src/pricing/discount.js';

assert.equal(applyDiscounts(1000, [{ type: 'percent', value: 10 }]), 900);
assert.equal(applyDiscounts(1000, [{ type: 'fixed', cents: 250 }]), 750);
assert.equal(applyDiscounts(1000, [{ type: 'fixed', cents: 1500 }]), 0);
assert.equal(discountCents(1000, [{ type: 'fixed', cents: 1500 }]), 1000);
