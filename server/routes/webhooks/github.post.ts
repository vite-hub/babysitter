import { createHmac, timingSafeEqual } from 'node:crypto'
import { defineEventHandler, getHeader, readRawBody, setResponseStatus } from 'h3'
import { host } from '../../agents/babysitter/agent.ts'
import { runtime } from '../../babysitter.runtime.ts'
import { useServerEnv } from '#vitehub/env/server'
import type { GitHubDelivery } from 'vite-hub/agent/server/github-inbox'

function validSignature(secret: string, body: string, signature: string | undefined) {
  if (!secret || !signature?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  const received = signature.slice('sha256='.length)
  if (!/^[0-9a-f]{64}$/i.test(received)) return false
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected))
}

export default defineEventHandler(async (event) => {
  const body = await readRawBody(event, 'utf8')
  const secret = useServerEnv().github.webhookSecret?.unseal() ?? ''
  if (!body || !validSignature(secret, body, getHeader(event, 'x-hub-signature-256'))) {
    setResponseStatus(event, 401)
    return { accepted: false, error: 'invalid signature' }
  }
  const deliveryId = getHeader(event, 'x-github-delivery')
  const eventName = getHeader(event, 'x-github-event') ?? 'unknown'
  if (!deliveryId) {
    setResponseStatus(event, 400)
    return { accepted: false, error: 'missing delivery id' }
  }
  let payload: GitHubDelivery
  try {
    payload = JSON.parse(body)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected object')
  } catch {
    setResponseStatus(event, 400)
    return { accepted: false, error: 'invalid JSON payload' }
  }
  // Intake owns PR/issue/SHA mapping. check_run and status deliveries often
  // omit pull_requests, and a base push may affect several local snapshots.
  // Commit delivery deduplication and projection together before waking work.
  const inbox = runtime.inbox.ingest(deliveryId, eventName, payload)
  // Closed PRs also wake reconciliation so their active owner can stop.
  if (inbox.updated.length > 0) host.wake()
  return { ...inbox, event: eventName, action: payload.action ?? null }
})
