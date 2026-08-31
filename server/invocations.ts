import { createClient } from '@libsql/client'
import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations/sqlite'
import { defineAgentInvocations, failInterruptedAgentInvocations, summarizeAgentInvocationWorkload } from 'vite-hub/agent/server'

const client = createClient({ url: 'file:.vitehub/invocations.sqlite' })
const store = createLibsqlAgentInvocationStore({ client, maxRecords: 1_000 })
const processStartedAt = Date.now()

// ponytail: Babysitter is single-host; use leases before sharing this database across owners.
async function recoverInterruptedInvocations() {
  try {
    await failInterruptedAgentInvocations(store, {
      before: processStartedAt,
      message: 'The Babysitter host stopped before this invocation finished.',
      recover: () => true,
    })
  }
  catch (error) {
    console.error(new Error('Could not recover interrupted Agent Invocations.', { cause: error }))
  }
}

await recoverInterruptedInvocations()

export const invocations = defineAgentInvocations({
  content: 'content',
  store,
})

type InvocationStatus = 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'

export async function readInvocationWorkload(processStartedAt: number) {
  const [recent, active] = await Promise.all([
    client.execute(`SELECT sequence, status
      FROM vitehub_agent_invocations ORDER BY sequence DESC LIMIT 100`),
    client.execute(`SELECT sequence, status,
      json_extract(record, '$.createdAt') AS created_at,
      json_extract(record, '$.startedAt') AS started_at
      FROM vitehub_agent_invocations
      WHERE status IN ('pending', 'running') ORDER BY sequence DESC`),
  ])
  const records = new Map<string, { createdAt: string, startedAt?: string, status: InvocationStatus }>(recent.rows.map(row => [String(row.sequence), {
    createdAt: '',
    status: invocationStatus(row.status),
  }]))
  for (const row of active.rows) {
    records.set(String(row.sequence), {
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      startedAt: typeof row.started_at === 'string' ? row.started_at : undefined,
      status: invocationStatus(row.status),
    })
  }
  return summarizeAgentInvocationWorkload([...records.values()], processStartedAt)
}

function invocationStatus(value: unknown): InvocationStatus {
  if (value === 'cancelled' || value === 'completed' || value === 'failed' || value === 'pending' || value === 'running') return value
  throw new TypeError(`[babysitter] Unknown invocation status ${JSON.stringify(value)}.`)
}
