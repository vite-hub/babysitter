#!/usr/bin/env node
// Build the data explorer's report.json from the derived rows and the Opus judgments.
//   node ops/review-audit/prep.mjs <audit-dir> <report.json>
// Every number on the page is computed here. Judged findings are a stratified sample; the weighted rates scale each
// stratum (before/after outcome markers × vitehub/other repos) to its share of all findings on closed PRs.
// Period and repository are both tab filters, so every dataset carries one aggregated set of rows per combination.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, out] = process.argv.slice(2)
if (!dir || !out) { console.error('usage: node ops/review-audit/prep.mjs <audit-dir> <report.json>'); process.exit(2) }
const load = name => JSON.parse(readFileSync(join(dir, name), 'utf8'))
const prs = load('derived/prs.json')
const findings = load('derived/findings.json')
const passes = load('derived/passes.json')

const MARKERS = '2026-11-07'
const UPDATED = '2026-11-13'
const P1 = 'Oct 1 – Nov 6'
const P2 = 'Nov 7 – 13'
const ALL = 'All since Oct 1'
const ALL_REPOS = 'All repositories'
const periodOf = iso => iso < MARKERS ? P1 : P2
const MAIN_REPOS = ['vite-hub/vitehub', 'onmax/comark-ui', 'vite-hub/drop', 'onmax/vite-doctor', 'nuxt-modules/better-auth']
const repoOf = repository => MAIN_REPOS.includes(repository) ? repository.split('/')[1] : 'Other repos'
const REPO_OPTIONS = [ALL_REPOS, ...MAIN_REPOS.map(r => r.split('/')[1]), 'Other repos']

// One copy of a row per period tab and repository tab it belongs to.
const expand = (rows, iso) => rows.flatMap(row => [ALL, periodOf(iso(row))].flatMap(period =>
  [ALL_REPOS, row.repository].map(repo => ({ ...row, period, repo }))))
const strip = (rows, fields) => rows.map(row => Object.fromEntries(Object.entries(row).filter(([k]) => !fields.includes(k))))
const groupCount = (rows, keys, extra = () => ({})) => {
  const map = new Map()
  for (const row of rows) {
    const k = keys.map(key => row[key]).join('\u0000')
    const entry = map.get(k) ?? { ...Object.fromEntries(keys.map(key => [key, row[key]])), n: 0 }
    entry.n += row.n ?? 1
    for (const [field, value] of Object.entries(extra(row))) entry[field] = (entry[field] ?? 0) + value
    map.set(k, entry)
  }
  return [...map.values()]
}
// Wide rows for a `bars` block: one row per period, repository tab and label, one field per segment.
const wide = (rows, label, segment, segments) => {
  const map = new Map()
  for (const row of rows) {
    const k = [row.period, row.repo, row[label]].join('\u0000')
    const entry = map.get(k) ?? { period: row.period, repo: row.repo, [label]: row[label], ...Object.fromEntries(segments.map(s => [s, 0])) }
    entry[row[segment]] = (entry[row[segment]] ?? 0) + (row.n ?? 1)
    map.set(k, entry)
  }
  return [...map.values()].map(entry => {
    const total = segments.reduce((s, k) => s + entry[k], 0)
    return { ...entry, end: `${total}` }
  })
}
// Every week × series for each tab combination, zeros included, sorted by week then series, so colors and order hold.
const complete = (rows, series, order, extra = []) => {
  const weeks = [...new Set(rows.map(r => r.week))].sort()
  const out = []
  for (const [, group] of Map.groupBy(rows, r => `${r.period}\u0000${r.repo}`)) {
    const { period, repo } = group[0]
    const have = new Map(group.map(r => [`${r.week}\u0000${r[series]}`, r]))
    for (const week of weeks) for (const name of order)
      out.push(have.get(`${week}\u0000${name}`) ?? { period, repo, week, [series]: name, n: 0, ...Object.fromEntries(extra.map(f => [f, 0])) })
  }
  return out
}
const prByKey = new Map(prs.map(p => [p.key, p]))
const touched = new Set(prs.filter(p => p.touched).map(p => p.key))
const work = findings.filter(f => touched.has(f.pr))
const weekOf = iso => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(5, 10).replace('-', '/')
}
const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const round = (x, d = 1) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d

// ---- Judged sample ----
const VALID = { 'valid-bug': 'Real bug', 'valid-minor': 'Real, minor', 'false-positive': 'False positive', unclear: 'Unclear' }
const VERDICT = {
  'correct-fix': 'Fixed right', 'partial-fix': 'Fixed partly', 'incorrect-fix': 'Fix was wrong',
  'unneeded-change': 'Changed a false alarm', 'correct-dismissal': 'Dismissed rightly',
  'wrong-dismissal': 'Dismissed a real issue', missed: 'Missed', 'n/a': 'Nothing to grade',
}
const verdictOf = j => j.action === 'fixed-by-person' ? 'A person fixed it' : j.action === 'not-babysitter' ? 'Nothing to grade' : VERDICT[j.verdict] ?? 'Nothing to grade'
const VERDICTS = ['Fixed right', 'Fixed partly', 'Dismissed rightly', 'Changed a false alarm', 'Fix was wrong', 'Dismissed a real issue', 'Missed', 'A person fixed it', 'Nothing to grade']
const VERDICT_TONES = ['good', 'fair', 'good', 'warn', 'bad', 'bad', 'bad', 'muted', 'muted']
const VALIDS = ['Real bug', 'Real, minor', 'False positive']
const ACTION = { fixed: 'Fixed', disproved: 'Disproved', declined: 'Declined', 'pre-existing': 'Pre-existing', duplicate: 'Duplicate', ignored: 'Ignored', 'fixed-by-person': 'A person fixed it', 'not-babysitter': 'Not its work' }
const REPLY = { accurate: 'Accurate', inaccurate: 'Inaccurate', 'no-reply': 'No reply' }
const OWNER = { author: "PR author's code", babysitter: "Babysitter's code", base: 'Base or merge' }
const SEVERITY = s => s === 'Unlabeled' ? 'No severity' : s

const findingById = new Map(findings.map(f => [f.id, f]))
const judgedPrs = []
const judged = []
for (const name of readdirSync(join(dir, 'judged')).filter(n => n.endsWith('.json')).sort()) {
  for (const pr of load(join('judged', name)).prs) {
    const meta = prByKey.get(pr.pr)
    judgedPrs.push({ ...pr, repository: repoOf(meta.repository), createdAt: meta.createdAt })
    for (const j of pr.findings) {
      const f = findingById.get(j.id)
      const reason = f.outcomeReason ?? ''
      judged.push({
        repository: repoOf(f.repository), reviewer: f.reviewer, severity: SEVERITY(f.severity),
        valid: VALID[j.valid], verdict: verdictOf(j), action: ACTION[j.action], reply: REPLY[j.reply], owner: OWNER[j.codeOwner],
        why: j.verdict !== 'wrong-dismissal' ? null
          : !reason ? 'No reply'
          : /budget/i.test(reason) ? 'Push budget spent'
          : /\bP2\b|advisory|policy|repair bar/i.test(reason) ? 'P2 findings are optional'
          : 'Other reason',
        pr: f.pr, url: f.id,
        title: f.title.replace(/!\[P\d Badge\]\([^)]*\)|<\/?sub>|\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
        note: j.note.slice(0, 320), createdAt: meta.createdAt,
        stratum: `${meta.createdAt < MARKERS ? 'before' : 'after'}·${f.repository === 'vite-hub/vitehub' ? 'vitehub' : 'other'}`,
      })
    }
  }
}

// Stratum weights: findings on closed PRs the Babysitter worked on, by era and repository group.
const closed = new Set(prs.filter(p => p.touched && (p.state === 'Merged' || p.state === 'Closed')).map(p => p.key))
const population = {}
for (const f of work.filter(f => closed.has(f.pr))) {
  const p = prByKey.get(f.pr)
  const s = `${p.createdAt < MARKERS ? 'before' : 'after'}·${f.repository === 'vite-hub/vitehub' ? 'vitehub' : 'other'}`
  population[s] = (population[s] ?? 0) + 1
}
const sampled = {}
for (const j of judged) sampled[j.stratum] = (sampled[j.stratum] ?? 0) + 1
for (const j of judged) j.weight = population[j.stratum] / sampled[j.stratum]
const rate = (rows, test, base) => {
  const b = rows.filter(base)
  const total = b.reduce((s, r) => s + r.weight, 0)
  return b.length >= 5 && total ? b.filter(test).reduce((s, r) => s + r.weight, 0) / total : null
}
const acted = j => ['Fixed', 'Disproved', 'Declined', 'Pre-existing', 'Duplicate'].includes(j.action)
const fixedBy = j => j.action === 'Fixed'
const dismissed = j => ['Disproved', 'Declined', 'Pre-existing', 'Duplicate'].includes(j.action)
const valid = j => j.valid === 'Real bug' || j.valid === 'Real, minor'
const any = () => true
const METRICS = [
  ['Findings that were real', valid, any],
  ['Real bugs, not minor', j => j.valid === 'Real bug', any],
  ['False positives', j => j.valid === 'False positive', any],
  ['Handled right, of what it acted on', j => ['Fixed right', 'Dismissed rightly'].includes(j.verdict), acted],
  ['Fixes that were right', j => j.verdict === 'Fixed right', fixedBy],
  ['Fixes that were partial', j => j.verdict === 'Fixed partly', fixedBy],
  ['Fixes that were wrong', j => j.verdict === 'Fix was wrong', fixedBy],
  ['Fixes for a false alarm', j => j.verdict === 'Changed a false alarm', fixedBy],
  ['Dismissals that were right', j => j.verdict === 'Dismissed rightly', dismissed],
  ['Real findings it dismissed or missed', j => ['Missed', 'Dismissed a real issue'].includes(j.verdict), valid],
  ["Findings on the Babysitter's own code", j => j.owner === "Babysitter's code", any],
  ['Acted-on threads with a true reply', j => j.reply === 'Accurate', acted],
]
const rates = REPO_OPTIONS.flatMap(repo => {
  const rows = judged.filter(j => repo === ALL_REPOS || j.repository === repo)
  return METRICS.map(([metric, test, base]) => ({
    repo, metric,
    before: round(rate(rows.filter(j => j.createdAt < MARKERS), test, base), 3),
    after: round(rate(rows.filter(j => j.createdAt >= MARKERS), test, base), 3),
    all: round(rate(rows, test, base), 3),
    base: rows.filter(base).length,
  }))
})

// ---- All findings, counted from GitHub ----
const HANDLING = {
  fixed: 'Fixed, replied', 'line changed by Babysitter': 'Changed, no reply',
  disproved: 'Dismissed, replied', declined: 'Dismissed, replied', 'pre-existing': 'Dismissed, replied', duplicate: 'Dismissed, replied',
  'other reply': 'Dismissed, replied', 'line changed by a person': 'A person changed it', 'line changed': 'A person changed it',
  'closed unchanged': 'Closed unchanged', 'open at merge': 'Open at merge', open: 'Still open',
}
const HANDLINGS = ['Fixed, replied', 'Changed, no reply', 'Dismissed, replied', 'A person changed it', 'Closed unchanged', 'Open at merge', 'Still open']
const findRows = expand(work.map(f => ({
  repository: repoOf(f.repository), reviewer: f.reviewer, severity: f.reviewer === 'Person' ? 'Person' : SEVERITY(f.severity),
  week: weekOf(f.createdAt), handling: HANDLING[f.handling] ?? 'Dismissed, replied',
  code: f.onBotCode ? "Babysitter's code" : 'Other code', createdAt: f.createdAt,
})), r => r.createdAt)
const findWeekReviewer = complete(groupCount(findRows, ['period', 'repo', 'week', 'reviewer']), 'reviewer', ['Pullfrog', 'Codex', 'Person'].filter(r => work.some(f => f.reviewer === r)))
const findWeekHandling = complete(groupCount(findRows, ['period', 'repo', 'week', 'handling']), 'handling', HANDLINGS)
const findWeekCode = complete(groupCount(findRows, ['period', 'repo', 'week', 'code']), 'code', ["Babysitter's code", 'Other code'])
const findSeverity = groupCount(findRows, ['period', 'repo', 'severity', 'reviewer'])

// ---- PRs ----
const worked = prs.filter(p => p.touched)
const prRows = expand(worked.map(p => ({
  repository: repoOf(p.repository), createdAt: p.createdAt,
  merged: p.mergedByBot ? 1 : 0, prs: 1, findings: p.findings, botCommits: p.botCommits,
})), r => r.createdAt)
const totals = groupCount(prRows, ['period', 'repo'], r => ({ merged: r.merged, prs: r.prs, findings: r.findings, botCommits: r.botCommits }))
const passRowsRaw = passes.filter(p => p.repository !== 'Unknown' && touched.has(p.pr))
for (const t of totals) {
  const ps = passRowsRaw.filter(p => (t.repo === ALL_REPOS || repoOf(p.repository) === t.repo) && (t.period === ALL || periodOf(p.started) === t.period))
  t.passes = ps.length
  t.tokens = ps.reduce((s, p) => s + p.input, 0)
}
const mergedWeekly = complete(groupCount(expand(worked.filter(p => p.mergedByBot).map(p => ({ repository: repoOf(p.repository), week: weekOf(p.mergedAt), createdAt: p.mergedAt })), r => r.createdAt), ['period', 'repo', 'week', 'repository']), 'repository', REPO_OPTIONS.slice(1))
const bucket = (value, edges) => edges.find(([limit]) => value < limit)[1]
const HOUR_BUCKETS = [[1, 'Under 1 h'], [3, '1 to 3 h'], [8, '3 to 8 h'], [24, '8 to 24 h'], [72, '1 to 3 days'], [Infinity, 'Over 3 days']]
const mergeHours = groupCount(expand(worked.filter(p => p.mergedByBot && p.hoursToMerge != null).map(p => ({ repository: repoOf(p.repository), hours: bucket(p.hoursToMerge, HOUR_BUCKETS), createdAt: p.createdAt })), r => r.createdAt), ['period', 'repo', 'hours'])
  .sort((a, b) => HOUR_BUCKETS.findIndex(x => x[1] === a.hours) - HOUR_BUCKETS.findIndex(x => x[1] === b.hours))
const repoTable = []
for (const period of [ALL, P1, P2]) {
  const inPeriod = p => period === ALL || periodOf(p.createdAt) === period
  for (const [repository, rows] of Map.groupBy(worked.filter(inPeriod), p => repoOf(p.repository))) {
    const merged = rows.filter(p => p.mergedByBot)
    const fs = work.filter(f => repoOf(f.repository) === repository && inPeriod(prByKey.get(f.pr)))
    const ps = passRowsRaw.filter(p => repoOf(p.repository) === repository && (period === ALL || periodOf(p.started) === period))
    repoTable.push({
      period, repository, prs: rows.length, merged: merged.length,
      hours: round(median(merged.map(p => p.hoursToMerge))),
      findingsPerPr: round(fs.length / rows.length),
      botCommitsPerPr: round(rows.reduce((s, p) => s + p.botCommits, 0) / rows.length),
      ownCode: fs.length ? round(fs.filter(f => f.onBotCode).length / fs.length, 3) : null,
      personAfter: round(rows.filter(p => p.personCommitsAfterBot > 0).length / rows.length, 3),
      tokensPerMerge: merged.length && ps.length ? Math.round(ps.reduce((s, p) => s + p.input, 0) / merged.length) : null,
    })
  }
}

// ---- Model passes ----
const OUTCOMES = ['Pushed a repair', 'Answered threads only', 'No push', 'Did not finish']
const passRows = expand(passRowsRaw.map(p => ({
  repository: repoOf(p.repository), week: weekOf(p.started), createdAt: p.started,
  outcome: p.pushed ? OUTCOMES[0] : p.disposition === 'Did not finish' ? OUTCOMES[3] : p.resolvedThreads ? OUTCOMES[1] : OUTCOMES[2],
  tokens: p.input, minutes: p.minutes,
})), r => r.createdAt)
const passWeekly = complete(groupCount(passRows, ['period', 'repo', 'week', 'outcome'], r => ({ tokens: r.tokens })), 'outcome', OUTCOMES, ['tokens'])
const MINUTE_BUCKETS = [[2, 'Under 2 min'], [5, '2 to 5 min'], [15, '5 to 15 min'], [30, '15 to 30 min'], [60, '30 to 60 min'], [Infinity, 'Over 1 h']]
const passMinutes = groupCount(passRows.filter(r => r.minutes > 0).map(r => ({ period: r.period, repo: r.repo, minutes: bucket(r.minutes, MINUTE_BUCKETS) })), ['period', 'repo', 'minutes'])
  .sort((a, b) => MINUTE_BUCKETS.findIndex(x => x[1] === a.minutes) - MINUTE_BUCKETS.findIndex(x => x[1] === b.minutes))

// ---- Judged aggregates ----
const judgedRows = expand(judged.map(({ weight, stratum, ...j }) => ({ ...j, n: 1 })), j => j.createdAt)
const matrixRows = groupCount(judgedRows, ['period', 'repo', 'valid', 'verdict'])
  .sort((a, b) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict))
const byReviewer = wide(judgedRows, 'reviewer', 'valid', VALIDS)
const bySeverity = wide(judgedRows, 'severity', 'valid', VALIDS)
const verdictByReviewer = wide(judgedRows, 'reviewer', 'verdict', VERDICTS)
const verdictByOwner = wide(judgedRows, 'owner', 'verdict', VERDICTS)
const replyByAction = wide(judgedRows, 'action', 'reply', Object.values(REPLY))
const whyDismissed = groupCount(judgedRows.filter(j => j.why), ['period', 'repo', 'why'])
const effectRows = wide(expand(judgedPrs.map(p => ({
  repository: p.repository, createdAt: p.createdAt,
  effect: { helped: 'Helped', neutral: 'Neutral', hurt: 'Hurt' }[p.effect],
  corrected: p.personCorrected ? 'A person corrected it' : 'No correction',
})), r => r.createdAt), 'effect', 'corrected', ['No correction', 'A person corrected it'])
  .sort((a, b) => ['Helped', 'Neutral', 'Hurt'].indexOf(a.effect) - ['Helped', 'Neutral', 'Hurt'].indexOf(b.effect))
const prNotes = strip(expand(judgedPrs.map(p => ({
  repository: p.repository, createdAt: p.createdAt, pr: p.pr,
  effect: { helped: 'Helped', neutral: 'Neutral', hurt: 'Hurt' }[p.effect],
  corrected: p.personCorrected ? 'Yes' : 'No', findings: p.findings.length, note: p.note.slice(0, 300),
})), r => r.createdAt), ['createdAt', 'repository'])
const evidence = strip(judgedRows, ['createdAt', 'n', 'why', 'action', 'owner', 'reply', 'repository'])

// ---- Words ----
const pct = x => x == null ? '–' : x > 0 && x < 0.005 ? 'under 1%' : `${Math.round(x * 100)}%`
const R = Object.fromEntries(rates.filter(r => r.repo === ALL_REPOS).map(r => [r.metric, r]))
const wrongDismissals = judged.filter(j => j.why)
const budget = wrongDismissals.filter(j => j.why === 'Push budget spent')
const dismissals = judged.filter(dismissed)
const segmentTones = { 'Real bug': 'bad', 'Real, minor': 'warn', 'False positive': 'muted' }

const report = {
  title: 'Babysitter review audit',
  subtitle: 'GitHub and worker logs · Oct 1 to Nov 13, 2026',
  intro: "How the Babysitter handles review findings: which were real, which it fixed or dismissed, and whether it was right. Opus 5.5 judged a sample against the code; the rest is counted from GitHub and the worker's logs.",
  updated: UPDATED,
  search: 'Search judged findings',
  filters: [
    { field: 'period', type: 'tabs', options: [ALL, P1, P2] },
    { field: 'repo', type: 'tabs', label: 'Repository', options: REPO_OPTIONS },
  ],
  data: {
    totals, rates, matrixRows, whyDismissed, byReviewer, bySeverity, verdictByReviewer, verdictByOwner, replyByAction, effectRows,
    prNotes, findWeekReviewer, findWeekHandling, findWeekCode, findSeverity, mergedWeekly, mergeHours, repoTable, passWeekly, passMinutes, evidence,
  },
  top: [{
    type: 'stats', items: [
      { label: 'PRs merged', value: { data: 'totals', field: 'merged' }, format: 'integer', hint: 'by the Babysitter' },
      { label: 'Review findings', value: { data: 'totals', field: 'findings' }, format: 'compact', hint: 'threads on its PRs' },
      { label: 'Babysitter commits', value: { data: 'totals', field: 'botCommits' }, format: 'compact' },
      { label: 'Model passes', value: { data: 'totals', field: 'passes' }, format: 'compact', hint: 'logs start Oct 25' },
      { label: 'Input tokens', value: { data: 'totals', field: 'tokens' }, format: 'compact', hint: 'logs start Oct 25' },
      { label: 'Findings judged', value: { data: 'evidence', agg: 'count' }, format: 'integer', hint: 'by Opus 5.5' },
    ],
  }],
  views: [
    {
      id: 'verdict', label: 'Verdict', summary: 'Were the findings real, and did the Babysitter handle them right?',
      blocks: [
        {
          type: 'facts', items: [
            { value: pct(R['Findings that were real'].all), text: `of review findings were real; false positives fell from ${pct(R['False positives'].before)} to ${pct(R['False positives'].after)} after Nov 7.` },
            { value: pct(R['Fixes that were right'].all), text: `of its fixes were right, and ${pct(R['Fixes that were right'].after)} since Nov 7; ${pct(R['Fixes that were wrong'].all)} were wrong.` },
            { value: `${wrongDismissals.length} of ${dismissals.length}`, text: `judged dismissals were wrong; ${budget.length} were P1s it confirmed, then declined because its push budget ran out.` },
            { value: pct(R["Findings on the Babysitter's own code"].all), text: `of findings point at code the Babysitter wrote: ${pct(R["Findings on the Babysitter's own code"].before)} before Nov 7, ${pct(R["Findings on the Babysitter's own code"].after)} after.` },
          ],
        },
        {
          type: 'table', title: 'Weighted rates, sample scaled to all findings', data: 'rates', rank: false, limit: 12,
          note: 'Each rate is a share of the base its name gives; – where fewer than 5 judged findings make the base.',
          columns: [
            { field: 'metric', label: 'Rate' },
            { field: 'before', label: P1, format: 'percent' },
            { field: 'after', label: P2, format: 'percent' },
            { field: 'all', label: 'All', format: 'percent' },
            { field: 'base', label: 'Judged base', format: 'integer' },
          ],
        },
        { type: 'matrix', title: 'What the Babysitter did, by whether the finding was real', data: 'matrixRows', x: 'valid', y: 'verdict', value: 'n', columns: VALIDS, note: 'Judged findings, unweighted.' },
        { type: 'bars', title: 'Why it dismissed real findings', data: 'whyDismissed', label: 'why', value: 'n', limit: 8, note: 'Judged findings graded "dismissed a real issue".' },
      ],
    },
    {
      id: 'reviewers', label: 'Reviewers', summary: 'How often each reviewer is right, and how much it posts.',
      blocks: [
        { type: 'bars', title: 'Judged findings by reviewer: real or not', data: 'byReviewer', label: 'reviewer', limit: 8, segments: VALIDS, tones: VALIDS.map(v => segmentTones[v]), percent: true, end: 'end' },
        { type: 'bars', title: 'Judged findings by severity: real or not', data: 'bySeverity', label: 'severity', limit: 8, segments: VALIDS, tones: VALIDS.map(v => segmentTones[v]), percent: true, end: 'end' },
        { type: 'chart', chart: 'stacked', title: 'Review findings per week, by reviewer', data: 'findWeekReviewer', x: 'week', y: 'n', series: 'reviewer', xType: 'nominal', xTitle: 'Week starting', note: 'Weeks of 09/28 and 11/09 are partial.' },
        { type: 'chart', chart: 'stacked', title: 'Review findings by severity', data: 'findSeverity', x: 'severity', y: 'n', series: 'reviewer', note: 'Pullfrog tagged severity only from Nov 7.' },
      ],
    },
    {
      id: 'handling', label: 'Handling', summary: 'What happened to every review thread, counted from GitHub.',
      blocks: [
        {
          type: 'chart', chart: 'stacked', title: 'What happened to each finding, per week', data: 'findWeekHandling', x: 'week', y: 'n', series: 'handling',
          stack: 'percent', tones: ['good', 'fair', 'accent', 'muted', 'warn', 'bad', 6], format: 'percent', xType: 'nominal', xTitle: 'Week starting', wide: true,
          note: 'Outcome replies start Nov 7; before that, most fixes landed without a reply.',
        },
        {
          type: 'chart', chart: 'stacked', title: "Findings on the Babysitter's own code, per week", data: 'findWeekCode', x: 'week', y: 'n', series: 'code',
          stack: 'percent', tones: ['warn', 'muted'], format: 'percent', xType: 'nominal', xTitle: 'Week starting',
          note: 'A review thread posted on a line from one of its own commits.',
        },
        { type: 'bars', title: 'Judged findings: what it did, by reviewer', data: 'verdictByReviewer', label: 'reviewer', limit: 8, segments: VERDICTS, tones: VERDICT_TONES, percent: true, end: 'end' },
        { type: 'bars', title: 'Judged findings: whose code, and what it did', data: 'verdictByOwner', label: 'owner', limit: 8, segments: VERDICTS, tones: VERDICT_TONES, percent: true, end: 'end' },
      ],
    },
    {
      id: 'throughput', label: 'Throughput', summary: 'How many PRs it merges, how fast, and how much it pushes.',
      blocks: [
        { type: 'chart', chart: 'stacked', title: 'PRs merged by the Babysitter, per week', data: 'mergedWeekly', x: 'week', y: 'n', series: 'repository', xType: 'nominal', xTitle: 'Week starting', note: 'Weeks of 09/28 and 11/09 are partial.' },
        { type: 'bars', title: 'Time from open to merge', data: 'mergeHours', label: 'hours', value: 'n', sort: 'data', limit: 6 },
        {
          type: 'table', title: 'Per repository', data: 'repoTable', sort: 'prs', limit: 8,
          columns: [
            { field: 'repository', label: 'Repository' },
            { field: 'prs', label: 'PRs worked', format: 'bar' },
            { field: 'merged', label: 'Merged by it', format: 'integer' },
            { field: 'hours', label: 'Median h to merge', format: 'number' },
            { field: 'findingsPerPr', label: 'Findings per PR', format: 'number' },
            { field: 'botCommitsPerPr', label: 'Its commits per PR', format: 'number' },
            { field: 'ownCode', label: 'Findings on its code', format: 'percent' },
            { field: 'personAfter', label: 'Person pushed after it', format: 'percent' },
            { field: 'tokensPerMerge', label: 'Tokens per merge', format: 'compact' },
          ],
        },
      ],
    },
    {
      id: 'cost', label: 'Model passes', summary: 'What each model pass did and what it cost in tokens, from Oct 25 when the logs start.',
      blocks: [
        { type: 'chart', chart: 'stacked', title: 'Model passes per week, by result', data: 'passWeekly', x: 'week', y: 'n', series: 'outcome', tones: ['good', 'fair', 'muted', 'bad'], xType: 'nominal', xTitle: 'Week starting', note: 'Logs start Oct 25, in the week of 10/19; week of 11/09 is partial.' },
        { type: 'chart', chart: 'stacked', title: 'Input tokens per week, by result', data: 'passWeekly', x: 'week', y: 'tokens', series: 'outcome', tones: ['good', 'fair', 'muted', 'bad'], format: 'compact', xType: 'nominal', xTitle: 'Week starting' },
        { type: 'bars', title: 'Minutes per model pass', data: 'passMinutes', label: 'minutes', value: 'n', sort: 'data', limit: 6 },
      ],
    },
    {
      id: 'replies', label: 'Its replies', summary: 'What the Babysitter says on threads, and whether it is true.',
      blocks: [
        { type: 'bars', title: 'Judged findings: its reply, by what it did', data: 'replyByAction', label: 'action', limit: 8, segments: Object.values(REPLY), tones: ['good', 'bad', 'muted'], percent: true, end: 'end' },
        { type: 'bars', title: 'Judged PRs: did its work help?', data: 'effectRows', label: 'effect', limit: 8, segments: ['No correction', 'A person corrected it'], tones: ['muted', 'bad'], end: 'end', sort: 'data' },
        {
          type: 'table', title: 'Judged PRs, one line each', data: 'prNotes', sort: 'findings', limit: 10, more: 30, search: true,
          columns: [
            { field: 'pr', label: 'PR' },
            { field: 'effect', label: 'Effect' },
            { field: 'corrected', label: 'Person corrected it' },
            { field: 'findings', label: 'Findings judged', format: 'integer' },
            { field: 'note', label: 'Judge note', truncate: true },
          ],
        },
      ],
    },
  ],
  bottom: [{
    type: 'table', style: 'rows', title: 'Judged findings', data: 'evidence', sort: 'pr', limit: 15, more: 40,
    columns: [
      { field: 'pr', label: 'PR' },
      { field: 'reviewer', label: 'Reviewer' },
      { field: 'severity', label: 'Severity' },
      { field: 'valid', label: 'Real?' },
      { field: 'verdict', label: 'Babysitter' },
      { field: 'note', label: 'Judge note', truncate: true },
      { field: 'url', label: 'Thread', format: 'link' },
    ],
  }],
  method: '',
}

const sampleNote = Object.entries(sampled).map(([s, n]) => `${s.replace('·', ' Nov 7, ')} ${n} of ${population[s]}`).join('; ')
report.method = [
  "**Sources.** PRs created Oct 1 to Nov 13 in the repositories the Babysitter watched, from GitHub: commits, reviews, review threads and replies. A PR counts as worked on when it has a Babysitter commit, comment, reply, model pass or merge. Model passes come from the worker's Codex session logs, which start Oct 25.",
  '**Findings.** A finding is a review thread from Pullfrog, Codex or a person on a worked-on PR. From Nov 7 the Babysitter tags each reply `fixed`, `disproved`, `declined`, `pre-existing` or `duplicate`; earlier replies are sorted by wording, and a thread with no reply counts as changed when its line moved after a Babysitter commit.',
  `**Judging.** Opus 5.5 agents read ${judged.length} findings on ${judgedPrs.length} closed PRs, sampled by hash in four strata (${sampleNote}). Each judge read the code at the commented commit and the fix, and graded the finding and the Babysitter's action. Weighted rates scale each stratum to its share of all findings; charts of judged findings show raw counts.`,
  '**Limits.** One judge per finding. PRs with more than 12 findings add 12.',
].join('\n\n')

writeFileSync(out, JSON.stringify(report))
console.log(rates.filter(r => r.repo === ALL_REPOS).map(r => `${r.metric}: ${pct(r.before)} → ${pct(r.after)} (all ${pct(r.all)}, n=${r.base})`).join('\n'))
console.log({ population, sampled, bytes: JSON.stringify(report).length, wrongDismissals: wrongDismissals.length, budget: budget.length, dismissals: dismissals.length })
