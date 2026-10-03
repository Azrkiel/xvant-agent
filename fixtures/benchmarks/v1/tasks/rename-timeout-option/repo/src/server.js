export function createServer(options = {}) {
  return { timeout: options.timeout ?? 5000, port: options.port ?? 80 };
}
