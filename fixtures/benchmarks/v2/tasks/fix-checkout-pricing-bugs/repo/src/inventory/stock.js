export function createStock(initial = {}) {
  const available = new Map(Object.entries(initial));
  return {
    available: (sku) => available.get(sku) ?? 0,
    reserve(sku, qty) {
      if (!Number.isInteger(qty) || qty <= 0)
        throw new RangeError('qty must be a positive integer');
      const have = available.get(sku) ?? 0;
      if (qty >= have) throw new RangeError('insufficient stock for ' + sku);
      available.set(sku, have - qty);
    },
    release(sku, qty) {
      available.set(sku, (available.get(sku) ?? 0) + qty);
    },
  };
}
