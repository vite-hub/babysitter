import { kv } from 'vite-hub/kv'

export type WebhookPullRequestState = {
  repository: string
  number: number
  generation: number
  dirty: boolean
  headSha: string | null
  author: string | null
  state: string | null
  events: Array<{ deliveryId: string; event: string; action: string | null; receivedAt: string }>
  updatedAt: string
  data: {
    pullRequest?: unknown
    comments: Record<string, unknown>
    reviews: Record<string, unknown>
    checks: Record<string, unknown>
  }
}

function key(repository: string, number: number) {
  return `babysitter/webhooks/pr/${repository}/${number}`
}

export async function recordWebhookPullRequestEvent(input: Omit<WebhookPullRequestState, 'generation' | 'dirty' | 'events' | 'updatedAt' | 'data'> & {
  deliveryId: string
  event: string
  action: string | null
  receivedAt: string
  payload: Record<string, unknown>
}) {
  const [readError, previous] = await kv.get(key(input.repository, input.number))
  if (readError) throw readError
  const old = previous as Partial<WebhookPullRequestState> | undefined
  const data = old?.data ?? { comments: {}, reviews: {}, checks: {} }
  const upsert = (collection: Record<string, unknown>, value: unknown) => {
    if (value && typeof value === 'object' && 'id' in value) {
      const id = String(value.id)
      if (input.action === 'deleted') delete collection[id]
      else collection[id] = value
    }
  }
  if (input.payload.pull_request) data.pullRequest = input.payload.pull_request
  upsert(data.comments, input.payload.comment)
  upsert(data.reviews, input.payload.review)
  upsert(data.checks, input.payload.check_run ?? input.payload.check_suite)
  const events = [...(old?.events ?? []), {
    deliveryId: input.deliveryId,
    event: input.event,
    action: input.action,
    receivedAt: input.receivedAt,
  }].slice(-100)
  const state: WebhookPullRequestState = {
    repository: input.repository,
    number: input.number,
    generation: (old?.generation ?? 0) + 1,
    dirty: true,
    headSha: input.headSha ?? old?.headSha ?? null,
    author: input.author ?? old?.author ?? null,
    state: input.state ?? old?.state ?? null,
    events,
    updatedAt: input.receivedAt,
    data,
  }
  const [writeError] = await kv.set(key(input.repository, input.number), state)
  if (writeError) throw writeError
  return state
}

export async function readWebhookPullRequestState(repository: string, number: number) {
  const [error, value] = await kv.get(key(repository, number))
  if (error) throw error
  return value as WebhookPullRequestState | undefined
}

export async function acknowledgeWebhookPullRequest(repository: string, number: number, generation: number) {
  const current = await readWebhookPullRequestState(repository, number)
  if (!current || current.generation !== generation) return current
  const next = { ...current, dirty: false }
  const [error] = await kv.set(key(repository, number), next)
  if (error) throw error
  return next
}
