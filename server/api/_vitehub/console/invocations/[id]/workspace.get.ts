import { defineEventHandler, getQuery, getRouterParam } from 'h3'
import { createGitHubInvocationWorkspaceHandler } from '@vite-hub/agent/server/github'
import { host } from '../../../../../host.ts'
import { github } from '../../../../../github.ts'

const inspect = createGitHubInvocationWorkspaceHandler({ host: github, invocations: host.invocations })
export default defineEventHandler(event => {
  const path = getQuery(event).path
  return inspect(getRouterParam(event, 'id') || '', typeof path === 'string' ? path : undefined)
})
