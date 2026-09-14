# Babysitter operating contract

The Babysitter is a persistent worker, not a one-shot report generator. Keep the service running and continue observing it after every change or restart.

For each open pull request, the durable queue and webhook snapshot are the source of truth. Coalesce events for the same head, claim the oldest eligible item, and let the agent repair, wait for an external check, or merge. A completed invocation without a pushed commit, merge, or explicit durable waiting state is not progress.

When a provider workspace is missing Git metadata, restore the source remote and exact branch ancestry before editing. Never create an orphan push. If the PR closes or another actor changes its head, cancel the old claim and release capacity. A head change proven to match the actual provider checkout HEAD is the worker’s own repair; let it finish resolving addressed threads and recording its result. Do not spend repeated agent passes polling unchanged checks; persist a wake condition and wait for the webhook.

After deploying, verify the active systemd release, health endpoint, queue state, webhook intake, and at least one real PR state transition. Keep babysitting until the queue is drained or every remaining item has a recorded, reproducible external blocker.

For an authorized restart, use ViteHub's existing drain signal: `systemctl kill --kill-whom=main --signal=SIGUSR2 babysitter-vitehub.service`. Poll `/api/drain` for `drained` while continuing user updates, then restart. Do not wait for an idle gap while the host keeps admitting new work.
