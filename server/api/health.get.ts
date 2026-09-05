import { useServerEnv } from '#vitehub/env/server'
import { defineEventHandler } from 'h3'
import { createAgentInspectionMetadata } from 'vite-hub/agent'
import babysitterAgent from '../agents/babysitter/agent.ts'
import { babysitterWorkload } from '../babysitter.schedule.ts'
import { resolveMaxOwners, resolveRepositories } from '../babysitter.queue.ts'
import { consoleClient } from '../console.ts'
import { github } from '../github.ts'
import { host } from '../host.ts'


type DiagnosticStatus = 'neutral' | 'ok' | 'warning'
type Diagnostic = { detail?: string, label: string, status: DiagnosticStatus, value: string }

export default defineEventHandler(async () => {
  const { maxOwners, repositories: configuredRepositories, repository } = useServerEnv().babysitter
  const repositories = resolveRepositories(configuredRepositories, repository)
  const ownerLimit = resolveMaxOwners(maxOwners)
  const capacity = createAgentInspectionMetadata(babysitterAgent).config?.driver.capacity
  const githubBudget = github.budget()
  const [githubDiagnostic, processHealth] = await Promise.all([checkGitHub(), host.health()])
  const counts = processHealth.workload
  const healthy = githubDiagnostic.status === 'ok' && processHealth.status === 'healthy'
  const diagnostics: Diagnostic[] = [
    githubDiagnostic,
    {
      label: 'GitHub budget',
      status: githubBudget.limited ? 'warning' : 'ok',
      value: githubBudget.limited ? 'Work queued' : 'Available',
      detail: githubBudget.limited
        ? `${githubBudget.remaining} GraphQL points · resumes ${new Date(githubBudget.resetAt).toISOString()}`
        : 'GraphQL admission reserve available',
    },
    ...processHealth.diagnostics,
    { label: 'Model', status: 'ok', value: 'gpt-6-astra', detail: 'Medium reasoning effort' },
    { label: 'Agent', status: 'ok', value: 'babysitter', detail: 'Pull-request convergence' },
    { label: 'Repositories', status: 'ok', value: `${repositories.length} configured`, detail: repositories.join(', ') },
    {
      label: 'Admission',
      status: capacity?.reason?.startsWith('sample-error:') ? 'warning' : 'ok',
      value: `Adaptive · ${capacity?.active ?? 0} active · ${capacity?.effectiveConcurrency ?? ownerLimit} admitted`,
      detail: `${capacity?.pending ?? 0} queued · hard max ${ownerLimit}${capacity?.reason ? ` · ${capacity.reason}` : ''}`,
    },
    { label: 'Work discovery', status: 'ok', value: 'On demand', detail: 'Startup, owner completion, and 2m repair scan' },
    { label: 'Console delivery', status: consoleClient ? 'ok' : 'neutral', value: consoleClient ? 'Connected' : 'Optional · not configured' },
  ]

  return {
    checkedAt: processHealth.checkedAt,
    diagnostics,
    status: healthy ? 'healthy' : 'degraded',
    summary: healthy ? 'Babysitter is operational' : 'Babysitter needs attention',
    workload: { ...counts, ...babysitterWorkload(), queued: capacity?.pending ?? 0 },
  }
})

async function checkGitHub(): Promise<Diagnostic> {
  try {
    await github.access({ fallback: true })
    return { label: 'GitHub', status: 'ok', value: 'Connected', detail: 'Credentials available' }
  }
  catch {
    return { label: 'GitHub', status: 'warning', value: 'Not connected', detail: 'Pull-request work is blocked' }
  }
}
