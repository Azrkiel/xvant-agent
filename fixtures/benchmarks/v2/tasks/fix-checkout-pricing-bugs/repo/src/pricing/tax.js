// Tax on an amount in cents, for a rate such as 0.0825.
export function taxCents(amountCents, rate) {
  if (typeof rate !== 'number' || rate < 0)
    throw new RangeError('rate must be a non-negative number');
  return Math.floor(amountCents * rate);
}
