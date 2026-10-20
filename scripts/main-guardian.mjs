#!/usr/bin/env node
// Opens one "repair main" pull request when one of main's watched workflows fails, so the Babysitter
// repairs main the same way it repairs any PR. PR CI runs only fast checks and the full suites run
// on main, so PRs that each pass can break main together, and nothing else fixes it.
//
// Runs from a systemd timer with the Babysitter's GitHub App environment:
// GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY.
// Usage: node scripts/main-guardian.mjs [--dry-run]
import { createSign } from 'node:crypto'

const repository = process.env.MAIN_GUARDIAN_REPOSITORY ?? 'vite-hub/vitehub'
const base = process.env.MAIN_GUARDIAN_BRANCH ?? 'main'
// pkg.pr.new builds every package with isolatedDeclarations, which `ci` does not. On 2026-10-19
// it failed on main for 4 h and every open PR inherited the failure.
const workflowNames = (process.env.MAIN_GUARDIAN_WORKFLOWS ?? process.env.MAIN_GUARDIAN_WORKFLOW ?? 'ci,pkg.pr.new').split(',').map(name => name.trim()).filter(Boolean)
const branchPrefix = 'babysitter/repair-main-'
const dryRun = process.argv.includes('--dry-run')

function appJwt() {
  const now = Math.floor(Date.now() / 1000)
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: process.env.GITHUB_APP_ID })}`
  const key = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n')
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key, 'base64url')}`
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
  return response.status === 204 ? undefined : await response.json()
}

const log = (message, fields = {}) => console.log(JSON.stringify({ event: `main-guardian.${message}`, repository, ...fields }))

const { token } = await api(`app/installations/${process.env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, { token: appJwt(), method: 'POST' })
const head = (await api(`repos/${repository}/commits/${base}`, { token })).sha

// A push run on main waits behind the one in progress. On 2026-10-20 a job whose runner vanished kept
// a ci run "in progress" for 9.5 h, and every later main run stayed pending. No job may run past 60
// minutes, so a job running for longer is stuck: force-cancel its run.
const stuckJobMs = Number(process.env.MAIN_GUARDIAN_STUCK_JOB_MINUTES ?? 90) * 60_000
for (const run of (await api(`repos/${repository}/actions/runs?branch=${base}&event=push&status=in_progress&per_page=20`, { token })).workflow_runs.filter(run => workflowNames.includes(run.name))) {
  const stuck = (await api(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, { token })).jobs.filter(job => job.status === 'in_progress' && Date.now() - Date.parse(job.started_at) > stuckJobMs)
  if (!stuck.length) continue
  if (dryRun) {
    log('would-cancel-stuck', { run: run.id, head_sha: run.head_sha, jobs: stuck.map(job => job.name) })
    continue
  }
  try {
    await api(`repos/${repository}/actions/runs/${run.id}/force-cancel`, { token, method: 'POST' })
    log('cancelled-stuck', { run: run.id, head_sha: run.head_sha, jobs: stuck.map(job => job.name) })
  }
  catch (error) {
    log('cancel-stuck-failed', { run: run.id, error: String(error).slice(0, 300) })
  }
}

const runs = (await api(`repos/${repository}/actions/runs?branch=${base}&event=push&head_sha=${head}&per_page=20`, { token })).workflow_runs.filter(run => workflowNames.includes(run.name))
let failed = runs.find(run => run.status === 'completed' && run.conclusion === 'failure')
// Main moves faster than its CI finishes, and a newer push cancels the queued run, so the tip rarely
// has a finished run. The guardian then never saw a red main. Fall back to the newest finished run
// of each watched workflow, if it finished after the last repair merged.
if (!failed) {
  const repairs = (await api(`repos/${repository}/pulls?state=closed&base=${base}&sort=updated&direction=desc&per_page=50`, { token })).filter(pull => pull.head.ref.startsWith(branchPrefix) && pull.merged_at)
  const repairedAt = Math.max(0, ...repairs.map(pull => Date.parse(pull.merged_at)))
  const finished = (await api(`repos/${repository}/actions/runs?branch=${base}&event=push&status=completed&per_page=100`, { token })).workflow_runs
    .filter(run => workflowNames.includes(run.name) && !['cancelled', 'skipped'].includes(run.conclusion) && Date.parse(run.created_at) > repairedAt)
  const latest = workflowNames.map(name => finished.find(run => run.name === name)).filter(Boolean)
  failed = latest.find(run => run.conclusion === 'failure')
}
if (!failed && (!runs.length || runs.some(run => run.status !== 'completed'))) {
  log('waiting', { head, reason: runs.length ? 'ci-running' : 'no-ci-run' })
  process.exit(0)
}
if (!failed) {
  log('green', { head })
  process.exit(0)
}

// One repair at a time: an open guardian PR is already working on main.
const open = (await api(`repos/${repository}/pulls?state=open&base=${base}&per_page=100`, { token })).find(pull => pull.head.ref.startsWith(branchPrefix))
if (open) {
  log('repair-open', { head, pull_request: open.number })
  process.exit(0)
}
const red = failed.head_sha
const branch = `${branchPrefix}${red.slice(0, 8)}`
if (await api(`repos/${repository}/git/ref/heads/${branch}`, { token })) {
  // This head already had a repair PR; wait for main to move instead of reopening the same one.
  log('already-attempted', { head, red, branch })
  process.exit(0)
}

const jobs = (await api(`repos/${repository}/actions/runs/${failed.id}/jobs?filter=latest&per_page=100`, { token })).jobs.filter(job => job.conclusion === 'failure')
const body = `${base} is red at ${red}: the \`${failed.name}\` run ${failed.html_url} failed.

Failed jobs:
${jobs.map(job => `- [${job.name}](${job.html_url})`).join('\n') || '- (see the run)'}

This PR starts with an empty commit. Read the failures with readBaseCheckEvidence and readBaseCheckLogs, reproduce them with focused tests, fix them on this branch, and push the repair. PR CI runs only the fast checks, so verify the failing suites locally. Do not report reviewedHead while the branch has no changes.

Opened automatically by the Babysitter main guardian.`

if (dryRun) {
  log('would-open', { head, branch, jobs: jobs.map(job => job.name) })
  process.exit(0)
}
const tree = (await api(`repos/${repository}/git/commits/${head}`, { token })).tree.sha
const commit = await api(`repos/${repository}/git/commits`, { token, method: 'POST', body: { message: `chore: start main repair for ${red.slice(0, 8)}`, tree, parents: [head] } })
await api(`repos/${repository}/git/refs`, { token, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } })
const pull = await api(`repos/${repository}/pulls`, { token, method: 'POST', body: { title: `fix: repair ${base} after ${red.slice(0, 8)}`, head: branch, base, body } })
log('opened', { head, branch, pull_request: pull.number, jobs: jobs.map(job => job.name) })
