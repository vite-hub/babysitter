import { createError, defineEventHandler, getQuery, getRouterParam } from 'h3'
import { invocations } from '../../../invocations.ts'
import { readWorkspaceFile, resolveSessionWorkspace, sessionWorkspaceFromInvocation } from '../../../session-workspace.ts'

export default defineEventHandler(async (event) => {
  const invocation = await invocations.get(getRouterParam(event, 'id') || '')
  if (!invocation) throw createError({ status: 404, statusText: 'Invocation not found' })
  try {
    const identity = sessionWorkspaceFromInvocation(invocation)
    if (!identity) throw createError({ status: 404, statusText: 'Workspace snapshot not found' })
    const path = getQuery(event).path
    if (typeof path === 'string') return await readWorkspaceFile(identity, path)
    return await resolveSessionWorkspace(invocation)
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    throw createError({
      cause: error,
      status: 422,
      statusText: error instanceof Error ? error.message : 'Workspace snapshot unavailable',
    })
  }
})
