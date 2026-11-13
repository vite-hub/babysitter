// Who is who on a PR. The Babysitter acts through its GitHub App: commits as `<app>[bot]`, comments and merges as `<app>`.
export const BOT = /^(vite-hub|vitehub-bot|vitehub-babysitter|onmax-babysitter|babysitter)(\[bot\])?$/i
export const reviewerOf = login => {
  if (!login) return 'Unknown'
  if (/^pullfrog/i.test(login)) return 'Pullfrog'
  if (/^chatgpt-codex-connector/i.test(login)) return 'Codex'
  if (BOT.test(login)) return 'Babysitter'
  if (/\[bot\]$|^(github-actions|dependabot|renovate|vercel|cloudflare|netlify|pkg-pr-new|codecov|changeset-bot|socket-security)/i.test(login)) return 'Other bot'
  return 'Person'
}

// Every collected PR, from each <audit-dir>/raw*/days/<repo>/<day>.jsonl.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
export function readPrs(dir) {
  const seen = new Map()
  for (const raw of readdirSync(dir).filter(n => n.startsWith('raw'))) {
    const days = join(dir, raw, 'days')
    if (!existsSync(days)) continue
    for (const repo of readdirSync(days))
      for (const day of readdirSync(join(days, repo)).sort())
        for (const line of readFileSync(join(days, repo, day), 'utf8').split('\n'))
          if (line) { const pr = JSON.parse(line); seen.set(`${pr.repository}#${pr.number}`, pr) }
  }
  return [...seen.values()]
}

// What an unmarked Babysitter reply says it did, from its wording (replies before outcome markers, 2026-11-07).
export function replyKind(body) {
  const text = body.replace(/<!--[\s\S]*?-->/g, ' ')
  if (/\bduplicate\b|same (finding|issue) as|already (reported|covered) (in|by)/i.test(text)) return 'duplicate'
  if (/pre-?existing|already on (main|the base)|exists on (main|the base)|not introduced by this/i.test(text)) return 'pre-existing'
  if (/^\s*(fixed|addressed|resolved|implemented|added|updated|changed|moved|removed|renamed)\b|\b(fixed|addressed) in [0-9a-f]{7,}|\bpushed [0-9a-f]{7,}/i.test(text)) return 'fixed'
  if (/\bdefer|^\s*(keeping|leaving)\b|advisory|follow-?up improvement|separate (pr|change|hardening)/i.test(text)) return 'declined'
  if (/\bexisting (schema|behavior|limitation|lock|code)/i.test(text)) return 'pre-existing'
  if (/declin|out of scope|won.?t (fix|change)|not (changing|worth)|intentional|by design|leave (it|this) as/i.test(text)) return 'declined'
  if (/not (a|an) (bug|issue|problem)|disprov|incorrect|doesn.?t (apply|happen)|does not (apply|happen)|cannot happen|can.?t happen|already (handles|handled|guarded|covered|validated|checks)|no change (is )?needed|false positive/i.test(text)) return 'disproved'
  if (/^\s*\w+ed\b|\bnow\b/i.test(text)) return 'fixed'
  return 'other reply'
}
