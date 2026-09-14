export type PassResult = { disposition: 'park' | 'retry'; text: string; waitForChecksHead?: string }

export function parsePassResult(value: unknown): PassResult | undefined {
  if (!value || typeof value !== 'object' || !('disposition' in value) || !('text' in value)
    || value.disposition !== 'park' && value.disposition !== 'retry' || typeof value.text !== 'string' || !value.text.trim()) return
  const hint = 'waitForChecksHead' in value && typeof value.waitForChecksHead === 'string' && /^[a-f0-9]{7,64}$/i.test(value.waitForChecksHead)
    ? value.waitForChecksHead.toLowerCase() : undefined
  // A malformed optional scheduling hint must not invalidate a successful repair.
  return { disposition: value.disposition, text: value.text, ...(hint ? { waitForChecksHead: hint } : {}) }
}

/** Resolve model shorthand only against Git proof owned by this invocation. */
export function resolveWaitHead(hint: string | undefined, provedHead: string | undefined, initialHead: string): string | undefined {
  if (!hint || !/^[a-f0-9]{7,64}$/i.test(hint)) return
  const head = provedHead ?? initialHead
  if (/^[a-f0-9]{40,64}$/.test(head) && head.startsWith(hint.toLowerCase())) return head
}

export const passResultSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'babysitter',
    validate(value: unknown) {
      const result = parsePassResult(value)
      return result ? { value: result } : { issues: [{ message: 'Expected a park/retry disposition and a non-empty text result.' }] }
    },
  },
}
