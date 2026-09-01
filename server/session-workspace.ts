import type { AgentInvocationRecord } from 'vite-hub/agent'
import { github } from './github.ts'

const maxWorkspaceFileSize = 512 * 1024
type GitHubRunner = typeof github.command

export type SessionWorkspaceIdentity = {
  pullRequest: number
  repository: string
  revision: string
}

export type SessionWorkspace = SessionWorkspaceIdentity & { paths: string[] }

export async function resolveSessionWorkspace(
  invocation: AgentInvocationRecord,
  runner: GitHubRunner = (args, options) => github.command(args, options),
): Promise<SessionWorkspace | undefined> {
  const workspace = sessionWorkspaceFromInvocation(invocation)
  if (!workspace) return
  const result = await runner([
    'api',
    '--method', 'GET',
    '-f', 'recursive=1',
    `repos/${workspace.repository}/git/trees/${workspace.revision}`,
  ], { repository: workspace.repository })
  const payload = JSON.parse(result.stdout) as { tree?: unknown, truncated?: unknown }
  if (payload.truncated === true) throw new Error('The Workspace tree is too large to inspect safely.')
  if (!Array.isArray(payload.tree)) throw new Error('GitHub did not return a Workspace tree.')
  const paths = payload.tree.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    return item.type === 'blob' && typeof item.path === 'string' ? [item.path] : []
  }).sort((left, right) => left.localeCompare(right))
  return { ...workspace, paths }
}

export async function readWorkspaceFile(
  workspace: SessionWorkspaceIdentity & { paths?: string[] },
  path: string,
  runner: GitHubRunner = (args, options) => github.command(args, options),
) {
  assertWorkspacePath(path)
  if (workspace.paths && !workspace.paths.includes(path)) {
    throw new Error('The requested file is not part of this Workspace snapshot.')
  }
  const endpointPath = path.split('/').map(encodeURIComponent).join('/')
  const result = await runner([
    'api',
    '--method', 'GET',
    '-f', `ref=${workspace.revision}`,
    `repos/${workspace.repository}/contents/${endpointPath}`,
  ], { repository: workspace.repository })
  const payload = JSON.parse(result.stdout) as Record<string, unknown>
  if (payload.type !== 'file' || typeof payload.content !== 'string') {
    throw new Error('GitHub did not return a file.')
  }
  const size = typeof payload.size === 'number' ? payload.size : 0
  if (size > maxWorkspaceFileSize) throw new Error('This file is too large to preview.')
  if (payload.encoding !== 'base64') throw new Error('This file cannot be previewed as text.')
  const bytes = Buffer.from(payload.content.replaceAll(/\s/g, ''), 'base64')
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    throw new Error('This binary file cannot be previewed as text.')
  }
  if (content.includes('\0')) throw new Error('This binary file cannot be previewed as text.')
  return { content, path, revision: workspace.revision, size: bytes.byteLength }
}

export function assertWorkspacePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid Workspace path.')
  }
}

export function sessionWorkspaceFromInvocation(invocation: AgentInvocationRecord): SessionWorkspaceIdentity | undefined {
  const repository = invocation.annotations?.['github.repository']
  const revision = invocation.annotations?.['github.head']
  const pullRequest = invocation.annotations?.['github.pullRequest']
  if (typeof repository !== 'string' || typeof revision !== 'string' || typeof pullRequest !== 'number') return
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Invalid GitHub repository.')
  }
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error('Invalid Git revision.')
  return { pullRequest, repository, revision }
}
