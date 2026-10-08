// A discount is { type: 'percent', value } or { type: 'fixed', cents }.
export function discountCents(subtotalCents, discounts = []) {
  let total = 0;
  for (const discount of discounts) {
    if (discount.type === 'percent')
      total += Math.round((subtotalCents * discount.value) / 100);
    else if (discount.type === 'fixed') total += discount.cents;
    else throw new TypeError('unknown discount type: ' + discount.type);
  }
  return total;
}

export function applyDiscounts(subtotalCents, discounts = []) {
  return subtotalCents - discountCents(subtotalCents, discounts);
}
