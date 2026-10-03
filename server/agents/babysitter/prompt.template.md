Work on PR #{{ data.context.pullRequestNumber }} in {{ data.context.pullRequestRepository }}: {{ data.context.pullRequestUrl }}.
Your checkout has commit {{ data.context.pullRequestHead }} on branch {{ data.context.pullRequestSourceBranch }}.

- Start from `.git/babysitter-pr-context.json` (threads, reviews, checks at pass start); query GitHub only for gaps or newer changes. Address review-body findings too. Resolve threads when fixed, addressed, or not worth changing, with a brief reason.
- Fix red CI. After a push, resolve fixed threads, then return.
- Resolve merge conflicts using the `resolving-merge-conflicts` skill.
- Once live required checks, approvals, mergeability, and remaining feedback are satisfied, squash-merge this PR using the verified head SHA. Preserve branches used by open child PRs. A ready PR needs a merge, not a no-change retry.
- Finish with a pushed repair, a merge, or a reproduced external blocker recorded in the result. When only CI or review remains pending, return a durable wait for the current head and let webhooks resume the work.
