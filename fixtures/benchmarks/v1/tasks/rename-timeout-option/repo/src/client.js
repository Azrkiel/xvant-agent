export function createClient(options = {}) {
  return { timeout: options.timeout ?? 1000 };
}
