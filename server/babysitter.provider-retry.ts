const PROVIDER_RETRIES = 3

export function isProviderRateLimit(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false
  const text = error instanceof Error ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}` : String(error)
  return /\b429\b|too many requests|rate limit/i.test(text)
}

export async function runWithProviderRetry<T>(
  run: () => Promise<T>,
  onExhausted: () => void,
  delay: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 10_000)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      // Cancellation and unrelated failures must not block other PRs.
      if (!isProviderRateLimit(error)) throw error
      if (attempt === PROVIDER_RETRIES) {
        onExhausted()
        throw error
      }
      await delay()
    }
  }
}
