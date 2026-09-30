import { reserveItem } from './stock.js';
import { applyDiscount } from './pricing.js';

export function main(order) {
  reserveItem(order.sku);
  return applyDiscount(order.total, order.code);
}
