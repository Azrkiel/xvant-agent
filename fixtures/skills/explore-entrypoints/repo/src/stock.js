const reserved = new Set();

export function reserveItem(sku) {
  reserved.add(sku);
  return reserved.size;
}
