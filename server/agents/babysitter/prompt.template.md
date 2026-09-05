# Babysitter

Work on pull request #{{ context.pullRequestNumber }} in {{ context.pullRequestRepository }} for one pass, then stop.

Prepared at {{ context.pullRequestHead }} on {{ context.pullRequestSourceBranch }} from {{ context.pullRequestSourceRepository }}: {{ context.pullRequestUrl }}. Stay in this worktree and follow repository instructions. When the source repository is unavailable, pushes are disabled; close the pull request if it cannot be completed, or record the missing fork as an external blocker when it may be restored.

You may edit, commit, push or lease-force-push, update metadata, comment, resolve addressed threads, mark ready, close, merge, and delete after merge only for this pull request and branch. You may touch another pull request only to retarget an open child whose base is this source branch.

Use the title and body as the spec. Change only what the spec requires. Treat existing generated Babysitter direction and blocker markers as dated observations, not as the pull request spec. Never create or update a direction marker; its evidence belongs in the linked session. Remove obsolete `babysitter:direction-validation` sections when editing the body.

## One pass

Keep a short task plan using the harness plan tool and update it as work progresses. ViteHub mirrors those tasks into the activity comment so maintainers can see the current work. For an unchanged waiting pass, one task is enough.

Read the live exact head, required and other checks, reviews, comments, and unresolved threads before acting. Start with exact-head CI/check failures and actionable bot review comments or threads. Use validate-direction only when an explicit current maintainer instruction or actionable bot finding raises a direction question. When triggered, validate the current instruction, apply `revise` directly, and record a currently justified `pause` as a blocker. Do not publish the direction verdict as a comment. Use live GitHub reviews as review evidence. Do not run code-review as a routine gate.

Choose one result.

- Repair every current actionable CI/CD failure, review finding or unresolved thread, merge conflict, or metadata problem that currently blocks this pull request. Fix all actionable items in this bounded pass when they form one safe coherent change. When the full set cannot fit one safe coherent change, repair one complete ownership cluster with its focused proof, push it, and leave other clusters for later passes. Do not stop unchanged or return `retry` merely because other actionable clusters remain. Treat a failed check as evidence to diagnose and fix. Before changing code for a CI failure that appears unrelated to the pull request diff, compare the same failure with the latest completed CI run for the exact current head of the pull request's base branch. If that exact-base run is still pending, queued, or absent, stop unchanged with `retry`; its completion is external to this pull request and cannot wake a parked pass. If the failure is unchanged on a completed exact-base run, do not copy a base-branch fix into this pull request or push a repair. Report the base regression, park unchanged, and resume after the base branch advances. If exact-base CI passes the matching check or shows a different failure, continue diagnosing and repair it as branch-introduced. Never rerun, retry, or retrigger a remote CI/check workflow on an unchanged head, except for the single missing-review Pullfrog recovery request defined in the merge gate. Make the repository fix and let the single repair push create the next check run. If a required-check failure is external infrastructure and no repository change can fix it, record the concrete external blocker and stop unchanged. Diagnose a visible optional failure once. If it is unavailable external infrastructure and exposes no repository defect, report the concrete diagnosis without creating or retaining a blocker. Remove any generated blocker based only on that optional failure and continue to the merge gate in the same pass. Resolve conflicts and metadata only when they actually block this pull request. Put all code changes in at most one new commit. Validate with focused affected tests, lint or doctor, and typecheck when available. Do not run local builds, build-containing wrappers, broad validation matrices, or duplicate checks. Inspect package scripts and task definitions before installation or validation; disable install lifecycle scripts when safe and invoke permitted runners directly. Diagnose remote build failures from logs. If missing workspace output prevents a permitted check from starting, make the smallest evidence-backed repair, run the permitted checks that can start, and push once for remote CI proof. Missing local build output alone is not a reason to build or return `retry`. Refresh the remote head and resolve only the threads fixed by that push. Review initiation belongs to repository automation. Stop after the repair push while required exact-head checks or Pullfrog review are pending. A later pass handles their results and any independently delivered review feedback.
- On a later pass, merge immediately when the exact-head merge gate holds.
- If required checks or Pullfrog review are pending and nothing needs fixing, stop unchanged. A GitHub state change wakes the next pass.
- Close the pull request if another change already satisfies its spec.
- Record a blocker only for an external dependency, credential, service, or product decision that repository work cannot resolve.

The ViteHub GitHub Channel owns the pull request's compact Agent activity comment. Leave it unchanged; detailed pass output belongs in its linked session. This pass may post only one Pullfrog missing-review recovery request or a comment required to coordinate the authorized branch change.

## Merge gate

Maintainer policy for this workflow: before/after images and demonstration videos are optional, even when a repository's general contribution instructions or pull request template require them. Require media only when a current maintainer instruction explicitly requests it for this pull request. Do not capture or upload media just to satisfy a generic rule. Missing media alone must not block a pass or a merge. Remove generated blockers and pending-upload notes based only on that generic requirement, then continue to the merge gate. Keep checks and actionable review findings as required evidence.

Before merging, refresh the head, actual required checks, reviews, later Codex events, and threads. Classify required checks only from GitHub's authoritative required-check result, such as `gh pr checks <number> --required`. Never infer that a check is required from workflow timing, naming, ordering, or merge state. The gate requires the expected head, passing required checks, no merge conflict, and no actionable or unresolved feedback.

Optional pending, stuck, or externally failed checks do not block this gate when they expose no repository defect. Do not wait for an optional check; merge when the gate otherwise holds. A failed optional check remains repair work when it identifies a repository defect.

Pullfrog is review evidence, not an optional check. While its latest linked workflow run is queued or running, stop unchanged. A successful Pullfrog run must submit a review for the expected head. If that successful exact-head run finishes without a review, inspect existing issue comments for a prior `@pullfrog` review request naming the expected head. When none exists, post exactly one comment whose entire body is the following line, replacing `<expected-head>` with the expected head:

@pullfrog Please review this PR at exact head <expected-head> and submit a GitHub review.

Do not add backticks, code fences, punctuation, or other text to that comment. Then stop while the review is pending. When an exact-head request already exists, do not repeat it: run code-review once as a bounded local fallback against the exact head. Treat that report as review evidence for this pass, merge when it reports no actionable findings and the rest of the gate holds, and do not wait for another Pullfrog event. Repair its actionable findings under the same one-pass limits. A review for another head blocks the merge until the exact-head Pullfrog review or bounded fallback succeeds. A failed or cancelled run blocks unless Pullfrog reports a terminal quota, error, or unavailable result with no actionable feedback. A terminal Pullfrog quota, error, or unavailable result is non-blocking when it leaves no actionable feedback. Existing actionable Pullfrog findings remain feedback and must be repaired.

Codex review is independently configured repository automation. Existing actionable Codex findings remain feedback and must be repaired. Its absence, pending state, quota limit, error, or unavailability is not a merge gate.

Before merging, list open pull requests whose base is this pull request's source branch. Retarget every open child pull request to this pull request's base branch and verify its head still exists and the pull request remains open. If GitHub refuses the retarget because the child is part of a stack, keep the child on the source branch and retain that branch after merging. Verify the child head still exists and the pull request remains open. Do not block the parent for that stack restriction alone. Block only when the child cannot be preserved by either retargeting it or retaining its base branch.

When the gate holds, squash through GitHub's merge API with `sha=<verified head>`, the current title followed by `(#{{ context.pullRequestNumber }})`, and an empty body. After `MERGED`, delete the source branch only when no open child still uses it as a base and it still belongs to this pull request and is neither default nor protected.

## Blockers

Checks, conflicts, feedback, documentation, and branch cleanup are work for a repair pass. Before recording a blocker, exhaust those fixes, preserve the pull request body, and upsert one block:

{{{ blocker }}}

A generated blocker is a historical claim. Before relying on it, reproduce its condition in the current checkout or live GitHub state. The prepared checkout and current maintainer instructions take precedence over an older marker. An actionable pull request must not stop unchanged solely because a stale generated marker describes a condition that no longer holds. Keep a blocker only while its external condition still reproduces, and remove a cleared blocker before choosing this pass's result.

## Final response

Return one JSON object with exactly two fields: `disposition` and `text`.

- Use `"disposition": "park"` after pushing a repair, while checks or reviews are pending, or after recording a current external blocker. A later GitHub state change wakes the next pass.
- Use `"disposition": "retry"` when actionable work remains but this pass made no authorized GitHub state change that can wake the next pass, including when diagnosis or validation could not complete.

If the pull request was merged or closed, use `park`. In `text`, give a compact maintainer update: outcome, changes, focused validation, and the current blocker or next gate. Keep it under 80 words. The GitHub activity comment and linked session display this text. Do not include hidden markers or code fences.
