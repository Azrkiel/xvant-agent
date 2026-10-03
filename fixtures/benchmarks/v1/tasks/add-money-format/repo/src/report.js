import { total } from './cart.js';

export function report(carts) {
  return carts.map((cart) => cart.id + ': ' + total(cart)).join('\n');
}
