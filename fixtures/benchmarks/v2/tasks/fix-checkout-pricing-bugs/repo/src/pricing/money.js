// Converts between decimal amounts and integer cents.
export function toCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount))
    throw new TypeError('amount must be a finite number');
  return Math.floor(amount * 100);
}

export function fromCents(cents) {
  return cents / 100;
}

export function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
