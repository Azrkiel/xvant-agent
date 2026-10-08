export function json(status, body) {
  return { status, body };
}

export function errorBody(code, message, extra = {}) {
  return { error: { code, message, ...extra } };
}
