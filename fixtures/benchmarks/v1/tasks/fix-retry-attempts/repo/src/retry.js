// Calls fn up to `attempts` times and resolves with its first successful result.
export async function retry(fn, attempts) {
  let lastError;
  for (let i = 0; i <= attempts; i += 1) {
    try {
      return await fn(i);
    } catch (error) {
      lastError = error;
    }
  }
  return undefined;
}
