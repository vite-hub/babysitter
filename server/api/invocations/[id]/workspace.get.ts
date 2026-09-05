import { createError, defineEventHandler, getQuery, getRouterParam } from 'h3'
import { invocations } from '../../../invocations.ts'
import { createGitHubWorkspaceInspector } from '@vite-hub/agent/server/github'
import { github } from '../../../github.ts'

const workspace = createGitHubWorkspaceInspector(github)

export default defineEventHandler(async (event) => {
  const invocation = await invocations.get(getRouterParam(event, 'id') || '')
  if (!invocation) throw createError({ status: 404, statusText: 'Invocation not found' })
  try {
    const repository = invocation.annotations?.['github.repository']
    const revision = invocation.annotations?.['github.head']
    const pullRequest = invocation.annotations?.['github.pullRequest']
    if (typeof repository !== 'string' || typeof revision !== 'string' || typeof pullRequest !== 'number') throw createError({ status: 404, statusText: 'Workspace snapshot not found' })
    const identity = { repository, revision, pullRequest }
    const path = getQuery(event).path
    if (typeof path === 'string') return await workspace.read(identity, path)
    return { ...identity, paths: await workspace.list(identity) }
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
