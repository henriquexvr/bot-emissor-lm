export async function retryAsync(fn, { maxAttempts = 3, baseDelay = 2000, maxDelay = 30000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export async function aguardarCondicao(
  condicao,
  { timeout = 250000, intervaloInicial = 1000, intervaloMaximo = 1200 } = {}
) {
  const inicio = Date.now();
  let intervalo = intervaloInicial;
  while (Date.now() - inicio < timeout) {
    if (await condicao()) return true;
    await new Promise((r) => setTimeout(r, intervalo));
    intervalo = Math.min(intervalo * 1.2, intervaloMaximo);
  }
  return false;
}
