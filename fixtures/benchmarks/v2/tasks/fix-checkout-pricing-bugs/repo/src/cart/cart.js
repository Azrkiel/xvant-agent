export function createCart() {
  const lines = new Map();
  return {
    add(sku, qty, priceCents) {
      const line = lines.get(sku);
      if (line) line.qty += qty;
      else lines.set(sku, { sku, qty, priceCents });
    },
    lines: () => [...lines.values()].map((line) => ({ ...line })),
    subtotalCents: () =>
      [...lines.values()].reduce((sum, l) => sum + l.qty * l.priceCents, 0),
  };
}
