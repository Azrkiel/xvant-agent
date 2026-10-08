# Bug report

Four separate problems were reported by the shop team.

1. **Prices are one cent too low.** A 19.99 item shows up as 19.98. `toCents(19.99)` must
   return `1999` and `toCents(0.57)` must return `57`.
2. **Discounts can make an order negative.** A fixed discount larger than the subtotal
   produces a negative total. The total discount must never exceed the subtotal, so
   `applyDiscounts(1000, [{ type: 'fixed', cents: 1500 }])` must return `0`. Several
   discounts add up (two 10% coupons take 20% off the subtotal) and the sum is capped the
   same way.
3. **The last unit cannot be bought.** With 3 units in stock, `reserve('a', 3)` throws
   "insufficient stock". Reserving exactly what is available must work and leave 0;
   reserving more than is available must still throw a `RangeError`.
4. **Tax is rounded down.** Tax on 1999 cents at 8.25% is 164.9175 cents and must be
   rounded to the nearest cent, 165, not cut to 164.

Do not change the public function names or signatures.
