import { applyDiscounts } from '../pricing/discount.js';
import { taxCents } from '../pricing/tax.js';
import { shippingCents } from '../shipping/shipping.js';

// Reserves stock for every cart line and prices the order.
export function checkout(cart, stock, options = {}) {
  const { discounts = [], taxRate = 0, weightGrams = 0 } = options;
  const lines = cart.lines();
  for (const line of lines)
    if (stock.available(line.sku) < line.qty)
      throw new RangeError('insufficient stock for ' + line.sku);
  for (const line of lines) stock.reserve(line.sku, line.qty);
  const subtotal = cart.subtotalCents();
  const discounted = applyDiscounts(subtotal, discounts);
  const tax = taxCents(discounted, taxRate);
  const shipping = lines.length ? shippingCents(weightGrams) : 0;
  return {
    lines,
    subtotalCents: subtotal,
    discountedCents: discounted,
    taxCents: tax,
    shippingCents: shipping,
    totalCents: discounted + tax + shipping,
  };
}
