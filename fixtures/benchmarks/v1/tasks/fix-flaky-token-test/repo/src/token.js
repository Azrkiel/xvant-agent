// Tokens expire ttlMs after they are issued.
export function issue(ttlMs, now = Date.now()) {
  return { expiresAt: now + ttlMs };
}

export function isValid(token, now = Date.now()) {
  return now < token.expiresAt;
}
