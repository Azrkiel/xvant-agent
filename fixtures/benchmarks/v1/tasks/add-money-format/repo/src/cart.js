export function total(cart) {
  return cart.items.reduce(
    (sum, item) => sum + item.priceCents * item.quantity,
    0,
  );
}
