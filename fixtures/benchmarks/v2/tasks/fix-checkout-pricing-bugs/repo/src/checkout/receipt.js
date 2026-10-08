import { formatMoney } from '../pricing/money.js';

export function formatReceipt(order) {
  const rows = order.lines.map(
    (l) => l.sku + ' x' + l.qty + '  ' + formatMoney(l.qty * l.priceCents),
  );
  rows.push('subtotal  ' + formatMoney(order.subtotalCents));
  rows.push('discounted  ' + formatMoney(order.discountedCents));
  rows.push('tax  ' + formatMoney(order.taxCents));
  rows.push('shipping  ' + formatMoney(order.shippingCents));
  rows.push('total  ' + formatMoney(order.totalCents));
  return rows.join('\n');
}
