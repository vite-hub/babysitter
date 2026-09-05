import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations/sqlite'
import { createProcessAgentInvocations } from 'vite-hub/agent/runtime/process'

export const invocations = await createProcessAgentInvocations({
  content: 'content',
  store: createLibsqlAgentInvocationStore({ maxRecords: 5_000, url: 'file:.vitehub/invocations.sqlite' }),
  // This database belongs exclusively to this service process.
  recovery: { before: Date.now(), recover: () => true },
})
