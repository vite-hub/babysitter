#!/usr/bin/env node
// Review convergence metrics for PRs merged in a window, from GitHub alone.
//   node ops/review-metrics.mjs <owner/repo> <since YYYY-MM-DD> [until YYYY-MM-DD] [--json]
// A round is one PR head that Pullfrog reviewed. "Own rounds" leaves out heads that only merge the base,
// so it compares with Anthropic's review-and-fix rounds (2.08 mean before, 1.32 after; 8.9% → 1.5% at 5+).
// Thread outcomes come from the worker's `vitehub-babysitter-outcome:<kind>` reply when it exists;
// older threads only show whether the line changed (outdated) or was closed unchanged.
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const json = args.includes('--json')
const [repository, since, until] = args.filter(arg => arg !== '--json')
if (!repository?.includes('/') || !/^\d{4}-\d{2}-\d{2}$/.test(since ?? '')) {
  console.error('usage: node ops/review-metrics.mjs <owner/repo> <since YYYY-MM-DD> [until YYYY-MM-DD] [--json]')
  process.exit(2)
}

const query = `query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:25,after:$cursor){
  pageInfo{hasNextPage endCursor}
  nodes{... on PullRequest{number mergedAt additions deletions
    commits(first:100){nodes{commit{oid parents{totalCount}}}}
    reviews(first:100){nodes{author{login} commit{oid}}}
    reviewThreads(first:100){nodes{isResolved isOutdated comments(first:10){nodes{author{login} body originalCommit{oid}}}}}}}}}`

// GitHub search returns at most 1000 results, so read the window one day at a time.
function* days(from, to) {
  for (let day = new Date(`${from}T00:00:00Z`); day <= to; day = new Date(day.getTime() + 864e5)) yield day.toISOString().slice(0, 10)
}
const end = until ? new Date(`${until}T00:00:00Z`) : new Date()
const prs = []
for (const day of days(since, end)) {
  let cursor
  do {
    const fields = ['-f', `query=${query}`, '-f', `q=repo:${repository} is:pr is:merged merged:${day}`]
    if (cursor) fields.push('-f', `cursor=${cursor}`)
    const page = JSON.parse(execFileSync('gh', ['api', 'graphql', ...fields], { encoding: 'utf8', maxBuffer: 256 * 1024 ** 2 })).data.search
    prs.push(...page.nodes)
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined
  } while (cursor)
}

const bots = { pullfrog: /^pullfrog/, codex: /^chatgpt-codex-connector/ }
const botOf = login => Object.keys(bots).find(bot => bots[bot].test(login ?? ''))
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
const share = (values, test) => values.length ? values.filter(test).length / values.length : 0

const rows = []
const threads = { pullfrog: {}, codex: {} }
const reviewedHeads = { pullfrog: [0, 0], codex: [0, 0] }
const count = (bucket, key) => { bucket[key] = (bucket[key] ?? 0) + 1 }
for (const pr of prs) {
  const merges = new Set(pr.commits.nodes.filter(node => node.commit.parents.totalCount > 1).map(node => node.commit.oid))
  const heads = { pullfrog: new Set(), codex: new Set() }
  for (const review of pr.reviews.nodes) {
    const bot = botOf(review.author?.login)
    if (bot && review.commit) heads[bot].add(review.commit.oid)
  }
  for (const bot of Object.keys(heads)) {
    reviewedHeads[bot][0] += heads[bot].size
    reviewedHeads[bot][1] += [...heads[bot]].filter(oid => merges.has(oid)).length
  }
  for (const thread of pr.reviewThreads.nodes) {
    const [first, ...replies] = thread.comments.nodes
    const bot = botOf(first?.author?.login)
    if (!bot) continue
    const bucket = threads[bot]
    count(bucket, 'total')
    count(bucket, `severity ${first.body.match(/\bP[0-3]\b/)?.[0] ?? 'unlabeled'}`)
    if (merges.has(first.originalCommit?.oid)) count(bucket, 'posted on a base-merge head')
    const marker = replies.map(reply => reply.body.match(/vitehub-babysitter-outcome:([\w-]+)/)?.[1]).find(Boolean)
    if (marker) count(bucket, `outcome ${marker}`)
    else count(bucket, thread.isOutdated ? 'no outcome, line changed' : thread.isResolved ? 'no outcome, closed unchanged' : 'no outcome, open at merge')
  }
  if (!heads.pullfrog.size) continue
  rows.push({
    number: pr.number,
    size: pr.additions + pr.deletions,
    rounds: heads.pullfrog.size,
    ownRounds: Math.max(1, [...heads.pullfrog].filter(oid => !merges.has(oid)).length),
  })
}

const summary = rounds => ({ mean: +mean(rounds).toFixed(2), oneRound: +share(rounds, n => n === 1).toFixed(3), fivePlus: +share(rounds, n => n >= 5).toFixed(3) })
const sizes = [[0, 100], [100, 500], [500, 2000], [2000, Infinity]].map(([lo, hi]) => {
  const bucket = rows.filter(row => row.size >= lo && row.size < hi)
  return { lines: `${lo}-${hi === Infinity ? '' : hi}`, prs: bucket.length, ...summary(bucket.map(row => row.ownRounds)) }
})
const report = {
  repository, since, until: until ?? 'now', merged: prs.length, reviewed: rows.length,
  rounds: summary(rows.map(row => row.rounds)),
  ownRounds: summary(rows.map(row => row.ownRounds)),
  baseMergeReviews: Object.fromEntries(Object.entries(reviewedHeads).map(([bot, [all, onMerge]]) => [bot, { heads: all, onBaseMerge: onMerge }])),
  threads, sizes,
  worst: rows.sort((a, b) => b.ownRounds - a.ownRounds).slice(0, 5),
}
if (json) console.log(JSON.stringify(report, null, 2))
else {
  const pct = n => `${(n * 100).toFixed(1)}%`
  console.log(`${repository} ${since}..${report.until}: ${report.merged} merged, ${report.reviewed} reviewed by Pullfrog`)
  for (const key of ['rounds', 'ownRounds']) console.log(`${key.padEnd(10)} mean ${report[key].mean}  1 round ${pct(report[key].oneRound)}  5+ ${pct(report[key].fivePlus)}`)
  for (const [bot, heads] of Object.entries(report.baseMergeReviews)) console.log(`${bot.padEnd(10)} reviewed heads ${heads.heads}, on a base merge ${heads.onBaseMerge}`)
  for (const [bot, bucket] of Object.entries(threads)) console.log(`${bot.padEnd(10)} threads ${JSON.stringify(bucket)}`)
  for (const size of sizes) console.log(`size ${size.lines.padEnd(9)} prs ${size.prs}  mean ${size.mean}  5+ ${pct(size.fivePlus)}`)
  console.log('worst', report.worst.map(row => `#${row.number} (${row.ownRounds})`).join(', '))
}
