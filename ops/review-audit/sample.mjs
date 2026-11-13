#!/usr/bin/env node
// Pick a stratified sample of PRs the Babysitter worked on and write one judge packet per batch.
//   node ops/review-audit/sample.mjs <audit-dir> [batches=9] [findings-per-batch=32] [scope=all|vitehub|other] [first-batch=1]
// Strata: before/after outcome markers (2026-11-07), vitehub vs the other repos. Each stratum gets the same number
// of batches, so the prep script reweights judged findings to each stratum's share of all findings. A PR with more
// than 12 findings contributes 12 of them, picked by hash. The pick is deterministic: PRs sorted by a hash of their key.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOT, readPrs, reviewerOf } from './derive-lib.mjs'

const [dir, batchArg, perArg, scope = 'all', firstArg = '1'] = process.argv.slice(2)
const batches = Number(batchArg ?? 9)
const perBatch = Number(perArg ?? 32)
const readJsonl = file => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const raw = new Map(readPrs(dir).map(pr => [`${pr.repository}#${pr.number}`, pr]))
const prs = JSON.parse(readFileSync(join(dir, 'derived/prs.json'), 'utf8'))
const findings = JSON.parse(readFileSync(join(dir, 'derived/findings.json'), 'utf8'))
const byPr = Map.groupBy(findings, f => f.pr)
const hash = text => createHash('sha256').update(text).digest('hex')

const MARKERS = '2026-11-07'
const inScope = p => scope === 'all' || (scope === 'vitehub') === (p.repository === 'vite-hub/vitehub')
const eligible = prs.filter(p => inScope(p) && p.touched && byPr.get(p.key)?.length && p.state !== 'Open' && p.state !== 'Draft')
const CAP = 12
const picks = new Map(eligible.map(p => [p.key, byPr.get(p.key).toSorted((a, b) => hash(a.id).localeCompare(hash(b.id))).slice(0, CAP)]))
const tooBig = eligible.filter(p => byPr.get(p.key).length > CAP)
const pool = eligible
const stratum = p => `${p.createdAt >= MARKERS ? 'after' : 'before'} markers · ${p.repository === 'vite-hub/vitehub' ? 'vitehub' : 'other repos'}`
const strata = Map.groupBy(pool, stratum)
const totalFindings = pool.reduce((s, p) => s + byPr.get(p.key).length, 0)
const plan = [...strata].map(([name, rows]) => {
  const n = rows.reduce((s, p) => s + byPr.get(p.key).length, 0)
  return { name, rows: rows.sort((a, b) => hash(a.key).localeCompare(hash(b.key))), share: n / totalFindings, findings: n, prs: rows.length }
})
// Largest remainder, at least one batch per stratum.
for (const s of plan) s.batches = Math.floor(batches / plan.length)
plan.sort((a, b) => b.findings - a.findings)
for (let i = 0; plan.reduce((t, s) => t + s.batches, 0) < batches; i++) plan[i % plan.length].batches++

const packet = pr => {
  const r = raw.get(pr.key)
  return {
    pr: pr.key, url: r.url, title: r.title, author: r.author?.login, state: pr.state,
    createdAt: r.createdAt, mergedAt: r.mergedAt, mergedBy: r.mergedBy?.login, size: pr.size,
    commits: r.commits.nodes.map(({ commit: c }) => ({
      oid: c.oid, at: c.committedDate, headline: c.messageHeadline,
      by: c.authors.nodes.map(a => a.user?.login ?? a.name).join(', '),
      bot: c.authors.nodes.some(a => BOT.test(a.user?.login ?? a.name)), merge: c.parents.totalCount > 1,
    })),
    reviews: r.reviews.nodes.filter(v => v.body?.trim()).map(v => ({ by: v.author?.login, at: v.submittedAt, state: v.state, commit: v.commit?.oid, body: v.body.slice(0, 1500) })),
    comments: r.comments.nodes.filter(c => !/vitehub-agent-activity/.test(c.body)).map(c => ({ by: c.author?.login, at: c.createdAt, body: c.body.slice(0, 1500) })),
    findings: r.reviewThreads.nodes.filter(t => picks.get(pr.key).some(f => f.id === t.comments.nodes[0]?.url)).map(t => {
      const [first, ...replies] = t.comments.nodes
      return {
        id: first.url, reviewer: reviewerOf(first.author?.login), path: t.path, line: t.line ?? t.originalLine,
        postedOnCommit: first.originalCommit?.oid, at: first.createdAt, resolved: t.isResolved, outdated: t.isOutdated,
        body: first.body.slice(0, 4000),
        replies: replies.map(c => ({ by: c.author?.login, at: c.createdAt, body: c.body.slice(0, 1500) })),
      }
    }),
  }
}

mkdirSync(join(dir, 'packets'), { recursive: true })
const manifest = []
let index = Number(firstArg) - 1
for (const s of plan) {
  let cursor = 0
  for (let b = 0; b < s.batches; b++) {
    const picked = []
    let n = 0
    while (cursor < s.rows.length && n < perBatch) {
      const pr = s.rows[cursor++]
      picked.push(pr)
      n += picks.get(pr.key).length
    }
    const file = join(dir, 'packets', `batch-${++index}.json`)
    writeFileSync(file, JSON.stringify({ stratum: s.name, prs: picked.map(packet) }, null, 1))
    manifest.push({ batch: index, stratum: s.name, prs: picked.length, findings: n, file })
  }
}
writeFileSync(join(dir, `packets/manifest-${scope}.json`), JSON.stringify({ plan: plan.map(({ rows, ...s }) => s), tooBig: tooBig.map(p => p.key), batches: manifest }, null, 1))
console.log(plan.map(({ rows, ...s }) => s))
console.log(manifest)
console.log(`${tooBig.length} PRs had more than ${CAP} findings and contribute ${CAP}`)
