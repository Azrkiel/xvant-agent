// Shipping cost in cents by parcel weight in grams.
export function shippingCents(weightGrams) {
  if (weightGrams <= 500) return 499;
  if (weightGrams <= 2000) return 899;
  return 1499;
}
