export const DEFAULTS = { timeout: 1000 };

export function describe(options = {}) {
  return 'timeout=' + (options.timeout ?? DEFAULTS.timeout);
}
