export type PassResult = { disposition: 'park' | 'retry'; text: string; waitForChecksHead?: string }

export function isExternalWaitResult(text: string): boolean {
  return /(?:exact[- ]base|unrelated|external|pending|in progress|waiting for|no (?:independent )?repair|cannot (?:start|run)|dependencies.*unavailable)/i.test(text)
    || /\b(?:ci|checks?|tests?|reviews?|pullfrog)\b[^.!?\n]{0,100}\b(?:queued|running)\b|\bwait for (?:[a-z]+\s+){0,3}webhooks?\b/i.test(text)
    || /Resource not accessible by integration/i.test(text)
      && /\bActions write access\b[^.!?\n]{0,100}\b(?:needed|required)\b[^.!?\n]{0,100}\brerun\b/i.test(text)
}

/** A bare park without a durable external gate still consumed an unsuccessful pass. */
export function classifyPassScheduling(result: { disposition?: PassResult['disposition']; text: string; waitForChecksHead?: string; terminal?: boolean }) {
  const parked = Boolean(result.terminal || result.waitForChecksHead !== undefined
    || result.disposition !== undefined && isExternalWaitResult(result.text))
  return { parked, noOp: !parked && result.disposition !== undefined }
}

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

/** A proved repair push starts checks and reviews whose webhooks resume the PR. */
export function pushedRepairWaitHead(provedHead: string | undefined, initialHead: string, currentHead: string | undefined): string | undefined {
  if (!provedHead || provedHead === initialHead) return
  return resolveExternalWaitHead(provedHead, initialHead, currentHead)
}

/** An external wait after a repair belongs to its proved checkout head. */
export function resolveExternalWaitHead(provedHead: string | undefined, initialHead: string, currentHead: string | undefined): string | undefined {
  const ownedHead = provedHead ?? initialHead
  if (/^[a-f0-9]{40,64}$/i.test(ownedHead) && ownedHead === currentHead) return ownedHead
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
