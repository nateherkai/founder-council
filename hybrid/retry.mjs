// hybrid/retry.mjs
const RETRYABLE_PROVIDER_ERRORS = new Set(["rate_limit", "network"]);

export function shouldRetryProviderError(errorType) {
  return RETRYABLE_PROVIDER_ERRORS.has(String(errorType || ""));
}

export function retryDelayMs(attempt, baseMs = 1500, capMs = 10000) {
  const n = Math.max(1, Math.trunc(Number(attempt) || 1));
  const base = Math.max(0, Math.trunc(Number(baseMs) || 0));
  const cap = Math.max(base, Math.trunc(Number(capMs) || base));
  return Math.min(cap, base * (2 ** (n - 1)));
}
