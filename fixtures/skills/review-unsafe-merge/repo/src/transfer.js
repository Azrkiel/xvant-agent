export function transfer(from, to, amount) {
  if (!(amount > 0)) throw new RangeError('amount must be positive');
  if (from.id === to.id) throw new Error('same account');
  from.balance -= amount;
  to.balance += amount;
}
