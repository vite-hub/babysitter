# Review audit

Builds the Babysitter review audit: a data explorer of how the worker handles review findings, with a sample
judged by Opus agents against the code. Run from the repository root; `.audit/` is ignored.

1. `node ops/review-audit/collect.mjs .audit/raw <since> "" [repo ...]` reads every PR created since `<since>` from
   GitHub (commits, reviews, threads, comments), one day at a time. It resumes from the days already saved and sleeps
   when the GraphQL budget runs low. Pass the repositories the worker watched; the state DB lists them
   (`select repository, count(*) from vitehub_agent_state_babysitter_pull_requests group by 1`).
2. `sudo node ops/review-audit/scan-passes.mjs /home/agents/.codex/sessions .audit/raw/passes.jsonl` summarizes every
   model pass from the worker's Codex session logs (tokens, tools, result). The logs only go back as far as
   `prune-codex-home` keeps them.
3. `node ops/review-audit/derive.mjs .audit` writes `derived/{prs,findings,passes}.json`.
4. `node ops/review-audit/sample.mjs .audit <batches> <findings-per-batch> <vitehub|other|all> <first-batch>` writes
   judge packets to `.audit/packets/`. Give one agent per packet the brief in `judge-prompt.md`, with the packet
   path and an output path in `.audit/judged/`.
5. `node ops/review-audit/prep.mjs .audit .audit/report.json` computes every number on the page.
6. Build the page with Drop's `data-explorer` skill: copy its `scripts/` and `assets/` from
   `https://drop.vitehub.dev/.well-known/skills/data-explorer/` into `ops/review-audit/skill/`, then
   `node ops/review-audit/skill/scripts/build.mjs .audit/report.json .audit/report.html --shots .audit/shots`.
