import { resolve } from 'node:path'
import { PullRequestInbox } from './babysitter.inbox.ts'
import { resolveRepositories } from './babysitter.queue.ts'
import { useServerEnv } from '#vitehub/env/server'

const env = useServerEnv().babysitter
const repositories = resolveRepositories(env.repositories, env.repository)

// One process owns this PR inbox. ViteHub owns process wake-ups and provider
// admission; the inbox currently owns durable generations and leases.
export const pullRequestInbox = new PullRequestInbox(resolve(process.cwd(), '.vitehub/pull-request-inbox.sqlite'), repositories)
// A process restart hands every abandoned lease back to the queue. The
// scheduler's process-owned invocation recovery handles agent sessions; this
// recovers the GitHub-specific PR claim beside it.
pullRequestInbox.recoverLeases()
