#!/usr/bin/env bash
# Route worker GitHub CLI traffic through the shared proxy. Never print tokens
# or remote URLs: a remote can contain credentials.
set -euo pipefail

proxy_host=ghx.onmax.me
export GH_HOST="$proxy_host"
if [[ -z "${GH_ENTERPRISE_TOKEN:-}" ]]; then
  export GH_ENTERPRISE_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
fi

normalize_repo() {
  local repo="$1"
  case "$repo" in
    https://github.com/*|https://ghx.onmax.me/*) repo="${repo#https://}"; repo="${repo#*/}" ;;
    github.com/*|ghx.onmax.me/*) repo="${repo#*/}" ;;
  esac
  repo="${repo%.git}"
  if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo 'Unsupported repository; expected a GitHub OWNER/REPO.' >&2
    return 2
  fi
  printf '%s/%s' "$proxy_host" "$repo"
}

args=("$@")
explicit_repo=false
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[i]}" in
    --) break ;;
    -b|--body|--body-file|-t|--title|-f|--field|-F|--raw-field|--jq|-q|--template|-H|--header|-m|--message|--input|--output|--search|--label|--assignee|--reviewer|--milestone|--project|--base|--head|--ref|--json|--format|--filename|--subject|--notes|--notes-file)
      # These consume text, not CLI options. Do not rewrite their content even
      # when it happens to start with -R, --repo, or a GitHub URL.
      if ((i+1 < ${#args[@]})); then i=$((i+1)); fi ;;
    --repo|-R)
      if ((i+1 < ${#args[@]})); then
        args[i+1]="$(normalize_repo "${args[i+1]}")"
        explicit_repo=true
        i=$((i+1))
      fi ;;
    --repo=*) args[i]="--repo=$(normalize_repo "${args[i]#--repo=}")"; explicit_repo=true ;;
    -R?*) args[i]="-R$(normalize_repo "${args[i]#-R}")"; explicit_repo=true ;;
    --hostname|-h)
      # -h is a hostname alias only for gh api; elsewhere it means help.
      if [[ "${args[i]}" == --hostname || "${args[0]:-}" == api ]]; then
        if ((i+1 < ${#args[@]})); then args[i+1]="$proxy_host"; i=$((i+1)); fi
      fi ;;
    --hostname=*) args[i]="--hostname=$proxy_host" ;;
    https://api.github.com/*)
      if [[ "${args[0]:-}" == api && "$i" == 1 ]]; then args[i]="${args[i]#https://api.github.com/}"; fi ;;
    https://github.com/*)
      if [[ "${args[0]:-}" == pr || "${args[0]:-}" == issue ]]; then
        if [[ "${args[i]}" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(pull|issues)/[0-9]+([/?\#].*)?$ ]]; then
          args[i]="https://$proxy_host/${args[i]#https://github.com/}"
        fi
      fi ;;
  esac
done

if [[ "$explicit_repo" == false ]]; then
  if [[ -n "${GH_REPO:-}" ]]; then
    export GH_REPO="$(normalize_repo "$GH_REPO")"
  else
    remote="$(git remote get-url origin 2>/dev/null || true)"
    # Match only known GitHub hosts and strip userinfo without exposing it.
    if [[ "$remote" =~ ^https://([^/@]+@)?(github\.com|ghx\.onmax\.me)/(.+)$ ]]; then
      export GH_REPO="$(normalize_repo "${BASH_REMATCH[3]}")"
    elif [[ "$remote" =~ ^git@(github\.com|ghx\.onmax\.me):(.+)$ ]]; then
      export GH_REPO="$(normalize_repo "${BASH_REMATCH[2]}")"
    fi
    unset remote
  fi
else
  # Explicit --repo wins even if inherited GH_REPO references another host.
  unset GH_REPO
fi

exec "${GHX_GH_PATH:-/usr/bin/gh}" "${args[@]}"
