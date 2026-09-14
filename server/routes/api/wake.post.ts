import { defineEventHandler } from 'h3'

export default defineEventHandler(async () => {
  const { host } = await import('../../agents/babysitter/agent.ts')
  host.wake()
  return { ok: true }
})
