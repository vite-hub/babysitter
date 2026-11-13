#!/usr/bin/env node
// Collect every PR in a window, with commits, reviews, review threads and PR comments.
//   node ops/review-audit/collect.mjs <out-dir> <since YYYY-MM-DD> [until YYYY-MM-DD|""] [repo ...]
// Reads GitHub through `gh api graphql`, one creation day at a time, because search caps at 1000 results.
// Each day lands in <out-dir>/days/<owner>__<repo>/<day>.jsonl as soon as it's read, so a rerun resumes; the last two
// days are always read again. When done, every day is joined into <out-dir>/prs.jsonl.
// A 5xx from GitHub halves the page size; a low GraphQL budget sleeps until it resets.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [out, since, until, ...repoArgs] = process.argv.slice(2)
if (!out || !/^\d{4}-\d{2}-\d{2}$/.test(since ?? '')) {
  console.error('usage: node ops/review-audit/collect.mjs <out-dir> <since YYYY-MM-DD> [until YYYY-MM-DD|""] [repo ...]')
  process.exit(2)
}
const repos = repoArgs.length ? repoArgs : ['vite-hub/vitehub', 'vite-hub/babysitter', 'vite-hub/brief', 'vite-hub/nuxt-agent', 'quiverdk/agents', 'onmax/quiver-babysitter', 'onmax/bitacora-agent']

const query = `query($q:String!,$cursor:String,$size:Int!){rateLimit{cost remaining resetAt}
  search(query:$q,type:ISSUE,first:$size,after:$cursor){
  pageInfo{hasNextPage endCursor}
  nodes{... on PullRequest{number url title state isDraft createdAt mergedAt closedAt additions deletions changedFiles
    author{login} mergedBy{login} baseRefName headRefName
    commits(first:100){totalCount nodes{commit{oid messageHeadline authoredDate committedDate additions deletions parents{totalCount}
      authors(first:3){nodes{name user{login}}}}}}
    reviews(first:60){nodes{author{login} state submittedAt body commit{oid}}}
    comments(first:60){nodes{author{login} createdAt body url}}
    reviewThreads(first:80){nodes{isResolved isOutdated path line originalLine
      resolvedBy{login}
      comments(first:12){nodes{author{login} createdAt body url originalCommit{oid} commit{oid}}}}}}}}}`

const sleep = seconds => execFileSync('sleep', [String(seconds)])
function* days(from, to) {
  for (let day = new Date(`${from}T00:00:00Z`); day <= to; day = new Date(day.getTime() + 864e5)) yield day.toISOString().slice(0, 10)
}

let size = 10
function page(q, cursor) {
  for (let attempt = 0; ; attempt++) {
    const fields = ['-f', `query=${query}`, '-f', `q=${q}`, '-F', `size=${size}`]
    if (cursor) fields.push('-f', `cursor=${cursor}`)
    try {
      const result = JSON.parse(execFileSync('gh', ['api', 'graphql', ...fields], { encoding: 'utf8', maxBuffer: 512 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] }))
      const limit = result.data.rateLimit
      if (limit.remaining < 300) {
        const wait = Math.max(30, Math.ceil((Date.parse(limit.resetAt) - Date.now()) / 1000) + 30)
        console.error(`GraphQL budget at ${limit.remaining}; sleeping ${wait}s until ${limit.resetAt}`)
        sleep(wait)
      }
      if (size < 10 && attempt === 0) size = Math.min(10, size * 2)
      return result.data.search
    } catch (error) {
      const text = `${error.stderr ?? ''}${error.message}`
      if (attempt >= 8) throw error
      if (/rate limit/i.test(text)) { console.error('rate limited; sleeping 10 min'); sleep(600); continue }
      if (/HTTP 50\d|timeout|timed out|Something went wrong/i.test(text)) size = Math.max(1, Math.floor(size / 2))
      console.error(`retry ${attempt + 1} (${q}, size ${size}): ${text.split('\n').find(Boolean)}`)
      sleep(5 * (attempt + 1))
    }
  }
}

const end = until ? new Date(`${until}T00:00:00Z`) : new Date()
const fresh = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)
for (const repository of repos) {
  const folder = join(out, 'days', repository.replace('/', '__'))
  mkdirSync(folder, { recursive: true })
  let count = 0
  for (const day of days(since, end)) {
    const file = join(folder, `${day}.jsonl`)
    if (existsSync(file) && day < fresh) continue
    const lines = []
    let cursor
    do {
      const result = page(`repo:${repository} is:pr created:${day}`, cursor)
      for (const pr of result.nodes) lines.push(JSON.stringify({ repository, ...pr }))
      cursor = result.pageInfo.hasNextPage ? result.pageInfo.endCursor : undefined
    } while (cursor)
    writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '')
    count += lines.length
  }
  console.error(`${repository}: ${count} PRs read`)
}

const all = repos.flatMap(repository => {
  const folder = join(out, 'days', repository.replace('/', '__'))
  return readdirSync(folder).sort().flatMap(name => readFileSync(join(folder, name), 'utf8').split('\n').filter(Boolean))
})
writeFileSync(join(out, 'prs.jsonl'), `${all.join('\n')}\n`)
console.error(`wrote ${all.length} PRs to ${join(out, 'prs.jsonl')}`)
