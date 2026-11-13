# Judge the Babysitter's handling of review findings

You audit how well the Babysitter, an automated PR repair agent, handles code review findings. It acts as the GitHub App `vite-hub` (commits as `vite-hub[bot]`; older commits may use another `*[bot]` App name). Reviewers are Pullfrog (`pullfrog*`), Codex (`chatgpt-codex-connector*`) and people.

Each packet file holds one PR: its commits (in order, `bot: true` marks Babysitter commits), reviews, PR comments, and every review thread with all replies. Since about 2026-11-07, the Babysitter answers each thread it resolves with an outcome marker (`fixed`, `disproved`, `declined`, `pre-existing`, `duplicate`) and a reason. Before that, there are no markers: work out from the commits what happened.

For every finding in `findings` of every packet, decide:

1. **Was the finding right?** Read the code it points at, at the commit it was posted on.
   - `valid-bug`: a real defect that matters (wrong behavior, crash, data loss, security, broken build or test).
   - `valid-minor`: correct but low stakes (docs, naming, small edge case, test gap, style the repo asks for).
   - `false-positive`: wrong. The code already handles it, the premise misreads the code, or it asks for something the PR doesn't need.
   - `unclear`: you can't tell after looking.
2. **What did the Babysitter do?** `fixed`, `disproved`, `declined`, `pre-existing`, `duplicate`, `ignored` (no reply and no change), `fixed-by-person` (a person's commit addressed it), `not-babysitter` (the PR or thread was outside its work, such as a closed PR before any pass).
3. **Was that right?**
   - `correct-fix`: the change fixes the issue and nothing nearby breaks.
   - `partial-fix`: addresses it but misses a case, or the reviewer re-raises a narrower version later.
   - `incorrect-fix`: the change doesn't fix it, breaks something, or a later review or person flags the fix as wrong.
   - `unneeded-change`: changed code for a false positive (churn).
   - `correct-dismissal`: disproved, declined, pre-existing or duplicate, and that was right.
   - `wrong-dismissal`: dismissed a finding that was valid.
   - `missed`: a valid finding left unaddressed at merge or close.
   - `n/a`: nothing to grade (a false positive nobody acted on, or `not-babysitter`).
4. **Whose code was it?** `author` (the PR's original change), `babysitter` (a line a Babysitter commit wrote), `base` (pre-existing code or a base merge).
5. **Reply quality** of the Babysitter's reply on that thread: `accurate`, `inaccurate` (claims a fix or proof the code doesn't support), `no-reply`.

Look at the code, don't trust the reply. Fetch with read-only `gh` calls, for example:
- `gh api repos/OWNER/REPO/commits/SHA --jq '.files[] | {filename, patch}'` for one commit's diff.
- `gh api 'repos/OWNER/REPO/contents/PATH?ref=SHA' --jq .content | base64 -d | sed -n 'START,ENDp'` for a file at a commit.
- `gh pr diff NUMBER -R OWNER/REPO` for the whole PR.
Never write to GitHub and never run anything in a local checkout: only read. Spend effort in proportion to stakes: a P1 claim of a bug deserves reading the code and the fix; a docs nit needs a glance. When several findings in a PR share the same root issue, judge each one but you may reuse what you read.

Also write one PR-level judgment: did the Babysitter's work on this PR help (`helped`, `neutral`, `hurt`), whether a person had to correct or redo its work (`personCorrected`: true/false), and one sentence why.

Write your result as JSON to the output path you were given, with this shape, and nothing else in the file:

```json
{
  "prs": [
    {
      "pr": "owner/repo#123",
      "effect": "helped | neutral | hurt",
      "personCorrected": false,
      "note": "one sentence",
      "findings": [
        {
          "id": "<the finding's id, its first comment URL>",
          "valid": "valid-bug | valid-minor | false-positive | unclear",
          "action": "fixed | disproved | declined | pre-existing | duplicate | ignored | fixed-by-person | not-babysitter",
          "verdict": "correct-fix | partial-fix | incorrect-fix | unneeded-change | correct-dismissal | wrong-dismissal | missed | n/a",
          "codeOwner": "author | babysitter | base",
          "reply": "accurate | inaccurate | no-reply",
          "confidence": "high | medium | low",
          "note": "one sentence with the evidence: what the code does, what the fix changed"
        }
      ]
    }
  ]
}
```

Every finding in every packet must appear exactly once. Then reply with only: the output path, the number of PRs and findings judged, and the three most telling observations in one line each.
