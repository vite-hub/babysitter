#!/usr/bin/env node
// Summarize every Babysitter model pass from the worker's Codex session logs.
//   sudo node ops/review-audit/scan-passes.mjs <sessions-dir> <out.jsonl>
// One line per session: PR, start/end, model, tokens, tools called, last message.
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

const [dir, out] = process.argv.slice(2)
const files = []
const walk = d => { for (const name of readdirSync(d)) { const p = join(d, name); statSync(p).isDirectory() ? walk(p) : name.endsWith('.jsonl') && files.push(p) } }
walk(dir)
files.sort()

const rows = []
for (const file of files) {
  const row = { file: file.slice(dir.length + 1), tools: {} }
  const prUrls = {}
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.length > 400_000 && !line.includes('"token_count"')) continue
    if (!row.repository) for (const m of line.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g)) { const k = `${m[1]}/${m[2]}#${m[3]}`; prUrls[k] = (prUrls[k] ?? 0) + 1 }
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const p = entry.payload ?? {}
    if (entry.type === 'session_meta') {
      row.started = p.timestamp ?? entry.timestamp
      const m = /pr-workspaces\/([^+/]+)\+([^+/]+)\+(\d+)/.exec(p.cwd ?? '')
      if (m) { row.repository = `${m[1]}/${m[2]}`; row.number = Number(m[3]) }
      row.cwd = p.cwd
    } else if (entry.type === 'turn_context') {
      row.model ??= p.model
      row.effort ??= p.effort ?? p.reasoning_effort
    } else if (p.type === 'token_count' && p.info?.total_token_usage) {
      const t = p.info.total_token_usage
      row.input = t.input_tokens; row.cached = t.cached_input_tokens; row.output = t.output_tokens; row.reasoning = t.reasoning_output_tokens
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const text = `${p.name ?? ''} ${typeof p.input === 'string' ? p.input : ''} ${typeof p.arguments === 'string' ? p.arguments : ''}`
      for (const m of text.matchAll(/mcp__t3_code__(\w+)/g)) row.tools[m[1]] = (row.tools[m[1]] ?? 0) + 1
      if (/git\s+push\b/.test(text)) row.tools.gitPush = (row.tools.gitPush ?? 0) + 1
    } else if (p.type === 'task_complete') {
      row.ended = entry.timestamp
      if (typeof p.last_agent_message === 'string') row.last = p.last_agent_message.slice(0, 1500)
    }
    if (entry.timestamp) row.lastAt = entry.timestamp
  }
  if (!row.repository) {
    const [top] = Object.entries(prUrls).sort((a, b) => b[1] - a[1])
    if (top) { const [repository, number] = top[0].split('#'); row.repository = repository; row.number = Number(number) }
  }
  rows.push(row)
}
writeFileSync(out, `${rows.map(r => JSON.stringify(r)).join('\n')}\n`)
console.error(`scanned ${rows.length} sessions`)
