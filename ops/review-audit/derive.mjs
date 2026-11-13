#!/usr/bin/env node
// Turn the collected GitHub PRs into the rows the audit works on.
//   node ops/review-audit/derive.mjs <audit-dir>
// Reads <audit-dir>/raw*/prs.jsonl and raw/passes.jsonl; writes <audit-dir>/derived/{prs,findings,passes}.json.
// A finding is a review thread, or a reviewer's PR comment that lists findings, on a PR the Babysitter worked on.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOT, readPrs, replyKind, reviewerOf } from './derive-lib.mjs'

const dir = process.argv[2]
if (!dir) { console.error('usage: node ops/review-audit/derive.mjs <audit-dir>'); process.exit(2) }

const readJsonl = file => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const prsRaw = readPrs(dir)
const passesRaw = existsSync(join(dir, 'raw/passes.jsonl')) ? readJsonl(join(dir, 'raw/passes.jsonl')) : []

const OUTCOME = /vitehub-babysitter-outcome:([\w-]+)/
const severityOf = body => body.match(/\bP([0-3])\b/)?.[0] ?? (/!\[P(\d)/.exec(body)?.[0]) ?? 'Unlabeled'
const hours = (a, b) => a && b ? (Date.parse(b) - Date.parse(a)) / 36e5 : null
const strip = body => body.replace(/<!--[\s\S]*?-->/g, '').replace(/<details>[\s\S]*?<\/details>/g, '').replace(/\s+/g, ' ').trim()

const prs = []
const findings = []
for (const pr of prsRaw) {
  const commits = pr.commits.nodes.map(({ commit }) => ({
    oid: commit.oid,
    at: commit.committedDate,
    headline: commit.messageHeadline,
    logins: commit.authors.nodes.map(a => a.user?.login ?? a.name),
    merge: commit.parents.totalCount > 1,
    additions: commit.additions,
    deletions: commit.deletions,
  }))
  for (const commit of commits) commit.bot = commit.logins.some(login => BOT.test(login))
  const botCommits = commits.filter(c => c.bot && !c.merge)
  const botCommitOids = new Set(botCommits.map(c => c.oid))
  const comments = pr.comments.nodes
  const botComments = comments.filter(c => BOT.test(c.author?.login ?? ''))
  const reviews = pr.reviews.nodes
  const threads = pr.reviewThreads.nodes
  const passes = passesRaw.filter(p => p.repository === pr.repository && p.number === pr.number)
  const touched = botCommits.length > 0 || botComments.length > 0 || passes.length > 0 || BOT.test(pr.mergedBy?.login ?? '')
    || threads.some(t => t.comments.nodes.some(c => BOT.test(c.author?.login ?? '')))
  const key = `${pr.repository}#${pr.number}`

  let prFindings = 0
  for (const thread of threads) {
    const [first, ...replies] = thread.comments.nodes
    if (!first) continue
    const reviewer = reviewerOf(first.author?.login)
    if (reviewer === 'Babysitter' || reviewer === 'Other bot') continue
    if (reviewer === 'Person' && first.author?.login === pr.author?.login && !replies.length) continue
    const botReplies = replies.filter(r => BOT.test(r.author?.login ?? ''))
    const outcomeReply = botReplies.find(r => OUTCOME.test(r.body))
    const outcome = outcomeReply?.body.match(OUTCOME)[1]
    const after = commits.filter(c => Date.parse(c.at) > Date.parse(first.createdAt) && !c.merge)
    const botAfter = after.filter(c => c.bot)
    const handling = outcome
      ?? (botReplies.length ? replyKind(botReplies[0].body)
        : thread.isOutdated && botAfter.length ? 'line changed by Babysitter'
        : thread.isOutdated && after.length ? 'line changed by a person'
        : thread.isOutdated ? 'line changed'
        : thread.isResolved ? 'closed unchanged'
        : pr.mergedAt ? 'open at merge' : 'open')
    prFindings++
    findings.push({
      id: first.url,
      pr: key,
      repository: pr.repository,
      number: pr.number,
      reviewer,
      reviewerLogin: first.author?.login ?? null,
      severity: reviewer === 'Person' ? 'Person' : severityOf(first.body),
      createdAt: first.createdAt,
      day: first.createdAt.slice(0, 10),
      path: thread.path,
      line: thread.line ?? thread.originalLine,
      onBotCode: botCommitOids.has(first.originalCommit?.oid),
      onBaseMerge: commits.some(c => c.merge && c.oid === first.originalCommit?.oid),
      commit: first.originalCommit?.oid ?? null,
      title: strip(first.body).slice(0, 220),
      body: first.body.slice(0, 4000),
      handling,
      marker: Boolean(outcome),
      outcomeReason: (outcomeReply ?? botReplies[0]) ? strip((outcomeReply ?? botReplies[0]).body).slice(0, 1200) : null,
      reviewerConfirmed: replies.some(r => reviewerOf(r.author?.login) === reviewer && reviewer !== 'Person' && /\b(addressed|fixed|resolved) in\b/i.test(r.body)),
      botReplies: botReplies.length,
      replyHours: hours(first.createdAt, (outcomeReply ?? botReplies[0])?.createdAt),
      otherReplies: replies.filter(r => !BOT.test(r.author?.login ?? '')).map(r => ({ login: r.author?.login, body: strip(r.body).slice(0, 600), at: r.createdAt })),
      resolved: thread.isResolved,
      resolvedBy: thread.resolvedBy?.login ?? null,
      outdated: thread.isOutdated,
      botCommitsAfter: botAfter.length,
      prMerged: Boolean(pr.mergedAt),
    })
  }

  const ownOpen = threads.filter(t => reviewerOf(t.comments.nodes[0]?.author?.login) !== 'Babysitter').length
  prs.push({
    key,
    repository: pr.repository,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    author: pr.author?.login ?? 'ghost',
    state: pr.mergedAt ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open',
    createdAt: pr.createdAt,
    day: pr.createdAt.slice(0, 10),
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    mergedBy: pr.mergedBy?.login ?? null,
    mergedByBot: BOT.test(pr.mergedBy?.login ?? ''),
    size: pr.additions + pr.deletions,
    files: pr.changedFiles,
    commits: commits.length,
    commitsTotal: pr.commits.totalCount,
    botCommits: botCommits.length,
    botLines: botCommits.reduce((sum, c) => sum + c.additions + c.deletions, 0),
    personCommitsAfterBot: (() => {
      const firstBot = botCommits[0]
      return firstBot ? commits.filter(c => !c.bot && !c.merge && Date.parse(c.at) > Date.parse(firstBot.at)).length : 0
    })(),
    baseMerges: commits.filter(c => c.merge).length,
    botComments: botComments.filter(c => !/vitehub-agent-activity/.test(c.body)).length,
    pullfrogReviews: new Set(reviews.filter(r => reviewerOf(r.author?.login) === 'Pullfrog').map(r => r.commit?.oid)).size,
    codexReviews: new Set(reviews.filter(r => reviewerOf(r.author?.login) === 'Codex').map(r => r.commit?.oid)).size,
    threads: ownOpen,
    findings: prFindings,
    hoursToMerge: hours(pr.createdAt, pr.mergedAt),
    passes: passes.length,
    inputTokens: passes.reduce((sum, p) => sum + (p.input ?? 0), 0),
    touched,
  })
}

const passes = passesRaw.filter(p => p.started).map(p => {
  let disposition = null
  let text = p.last ?? ''
  try { const parsed = JSON.parse(p.last); disposition = parsed.disposition ?? null; text = parsed.text ?? text } catch {}
  return {
    repository: p.repository ?? 'Unknown',
    number: p.number ?? null,
    pr: p.repository ? `${p.repository}#${p.number}` : null,
    started: p.started,
    day: p.started.slice(0, 10),
    minutes: p.ended || p.lastAt ? (Date.parse(p.ended ?? p.lastAt) - Date.parse(p.started)) / 6e4 : null,
    model: p.model ?? 'Unknown',
    effort: p.effort ?? 'Unknown',
    input: p.input ?? 0,
    cached: p.cached ?? 0,
    output: p.output ?? 0,
    pushed: (p.tools.pushRepair ?? 0) > 0,
    commits: p.tools.commitRepair ?? 0,
    resolvedThreads: p.tools.resolveReviewThread ?? 0,
    commented: (p.tools.commentOnPullRequest ?? 0) > 0,
    completed: Boolean(p.ended),
    disposition: disposition ?? (p.ended ? 'Unknown' : 'Did not finish'),
    text: text.slice(0, 600),
  }
})

mkdirSync(join(dir, 'derived'), { recursive: true })
writeFileSync(join(dir, 'derived/prs.json'), JSON.stringify(prs))
writeFileSync(join(dir, 'derived/findings.json'), JSON.stringify(findings))
writeFileSync(join(dir, 'derived/passes.json'), JSON.stringify(passes))

const touched = prs.filter(p => p.touched)
const count = (rows, field) => Object.entries(rows.reduce((m, r) => ({ ...m, [r[field]]: (m[r[field]] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])
console.log(`PRs ${prs.length}, touched by the Babysitter ${touched.length}, merged by it ${prs.filter(p => p.mergedByBot).length}`)
console.log('findings on touched PRs', findings.filter(f => touched.some(p => p.key === f.pr)).length)
console.log('reviewers', count(findings, 'reviewer'))
console.log('handling', count(findings, 'handling'))
console.log('passes', passes.length, 'dispositions', count(passes, 'disposition'))
