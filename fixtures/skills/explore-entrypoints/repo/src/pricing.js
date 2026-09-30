import { formatCurrency } from './util/format.js';

export function applyDiscount(total, code) {
  const value = code === 'TEN' ? total * 0.9 : total;
  return formatCurrency(value);
}
