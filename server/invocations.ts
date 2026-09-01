import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations/sqlite'
import { defineAgentInvocations, failInterruptedAgentInvocations } from 'vite-hub/agent/server'

const store = createLibsqlAgentInvocationStore({
  maxRecords: 5_000,
  url: 'file:.vitehub/invocations.sqlite',
})
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
