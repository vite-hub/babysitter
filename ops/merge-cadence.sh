#!/usr/bin/env bash
# Prints one line per interval with merge cadence and why green PRs are not merging.
# Usage: ops/merge-cadence.sh [interval-seconds]. See ops/README.md.
set -u
interval=${1:-600}
if [[ ! "$interval" =~ ^[1-9][0-9]*$ ]]; then
  echo 'interval-seconds must be a positive integer' >&2
  exit 1
fi
unit=${BABYSITTER_UNIT:-babysitter-vitehub.service}
port=${BABYSITTER_PORT:-$(systemctl show "$unit" -p Environment | grep -oP 'PORT=\K\d+' || echo 3028)}
repos=${BABYSITTER_REPOS:-$(systemctl show "$unit" -p Environment | grep -oP 'BABYSITTER_REPOS=\K[^ ]+')}
if [[ -z "$repos" ]]; then
  echo 'set BABYSITTER_REPOS to a comma-separated repository list' >&2
  exit 1
fi
mainRepo=${BABYSITTER_MAIN_REPO:-vite-hub/vitehub}
mainBranch=${BABYSITTER_MAIN_BRANCH:-main}
since=$(date '+%Y-%m-%d %H:%M:%S')
while true; do
  sleep "$interval"
  now=$(date '+%Y-%m-%d %H:%M:%S')
  journal=$(sudo journalctl -u "$unit" --since "$since" --until "$now" -o cat 2>/dev/null)
  count() { grep -c "\"event\":\"$1\"" <<<"$journal"; }
  # Async merges finish through the webhook without owner.merged, so ask GitHub what was merged.
  # -u would also parse $since as UTC; convert the local time through epoch seconds.
  sinceUtc=$(date -u -d "@$(date -d "$since" +%s)" +%Y-%m-%dT%H:%M:%SZ)
  # The search index lags by minutes, so read recently updated closed PRs from each repository.
  mergedPrs=$(for repo in ${repos//,/ }; do
    gh api "repos/$repo/pulls?state=closed&sort=updated&direction=desc&per_page=50" --jq ".[] | select(.merged_at != null and .merged_at >= \"$sinceUtc\") | \"${repo#*/}#\(.number)\"" 2>/dev/null
  done | paste -sd' ')
  merged=$(wc -w <<<"$mergedPrs")
  failed429=$(grep '"babysitter.owner.failed"' <<<"$journal" | grep -c '429')
  hostOnly=$(count babysitter.provider.quota.host_only)
  pausedUntil=$(grep '"babysitter.provider.quota.host_only"' <<<"$journal" | tail -1 | grep -oE '"blocked_until":"[^"]{16}' | cut -d'"' -f4 | cut -c12-)
  passes=$(count babysitter.context.prepared)
  inputM=$(grep '"event":"\$ai_trace"' <<<"$journal" | grep '"\$ai_span_name":"agent.run"' | grep -oE '"input_tokens":[0-9]+' | cut -d: -f2 | awk '{s+=$1} END {printf "%.0f", s/1e6}')
  baseFailing=$(grep '"babysitter.wait.kept"' <<<"$journal" | grep -c '"reason":"base-failing"')
  retests=$(count babysitter.branch.retest)
  forge=$(count babysitter.forge.quota.blocked)
  skips=$(grep '"babysitter.direct_merge.skipped"' <<<"$journal" | grep -oE '"reason":"[^"]*"' | sed -E 's/"reason":"//; s/"$//; s/[0-9]+ new feedback items?/N new feedback items/' | sort | uniq -c | sort -rn | head -4 | awk '{c=$1; $1=""; printf "%s%s=%s", (NR>1?", ":""), substr($0,2), c}')
  health=$(curl -fsS -m 10 "http://127.0.0.1:$port/api/health")
  queue=$(grep -oE '"queue":\{[^}]*\}' <<<"$health" | sed 's/"queue"://')
  release=$(grep -oE '"release":"[0-9a-f]{7}' <<<"$health" | cut -d'"' -f4)
  # Non-required checks do not block merges.
  required=$(gh api "repos/$mainRepo/branches/$mainBranch/protection/required_status_checks" --jq '.contexts' 2>/dev/null || echo '[]')
  mainFailing=$(gh api "repos/$mainRepo/commits/$mainBranch/check-runs?per_page=100" --jq "[.check_runs[] | select(.conclusion==\"failure\" and (.name as \$n | $required | index(\$n)))] | length" 2>/dev/null || echo "?")
  alert=""
  [ "$mainFailing" != 0 ] && alert=" ALERT:main-red($mainFailing jobs)"
  [ "$merged" = 0 ] && alert="$alert ALERT:no-merges"
  [ "$forge" -gt 0 ] && alert="$alert ALERT:forge-quota"
  [ -z "$queue" ] && alert="$alert ALERT:health-down"
  echo "$(date -u +%H:%MZ) release=$release merged=$merged [$mergedPrs] 429=$failed429 model_passes=$passes input=${inputM}M base_failing_parks=$baseFailing retests=$retests host_only=$hostOnly${pausedUntil:+(until ${pausedUntil}Z)} queue=$queue skips: $skips$alert"
  since=$now
done
