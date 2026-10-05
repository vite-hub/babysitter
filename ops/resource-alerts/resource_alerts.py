#!/usr/bin/env python3
"""Warn Maxi before shared Slimbook resources run out.

Each run, as svc-cliproxy:
- writes a sanitized per-account quota summary that the Babysitter's admission guard reads;
- alerts when /tmp passes 85%, a proxy account is unavailable or past 80% weekly use,
  or the Babysitter's input tokens reach its budget.

Alerts go to the journal at warning priority and, when a webhook file exists, to Discord.
The summary never contains emails, tokens, or status messages.
"""
from __future__ import annotations

import concurrent.futures
from datetime import datetime
import json
import os
from pathlib import Path
import time
import urllib.request

ENV = os.environ
HOME = Path.home()
MANAGEMENT_KEY = Path(ENV.get("CLIPROXY_MANAGEMENT_KEY_FILE", "/srv/cliproxy/.config/cliproxyapi/management.key"))
MANAGEMENT_URL = ENV.get("CLIPROXY_MANAGEMENT_URL", "http://127.0.0.1:8317/v0/management")
STATUS_FILE = Path(ENV.get("RESOURCE_ALERTS_STATUS_FILE", "/srv/cliproxy-status/accounts.json"))
STATE_FILE = Path(ENV.get("RESOURCE_ALERTS_STATE_FILE", HOME / ".local/state/resource-alerts/state.json"))
WEBHOOK_FILE = Path(ENV.get("RESOURCE_ALERTS_WEBHOOK_FILE", HOME / ".config/resource-alerts/discord-webhook"))
BABYSITTER_HEALTH = ENV.get("BABYSITTER_HEALTH_URL", "http://127.0.0.1:3028/api/health")
TMP_PATH = ENV.get("RESOURCE_ALERTS_TMP_PATH", "/tmp")
TMP_PERCENT = float(ENV.get("RESOURCE_ALERTS_TMP_PERCENT", "85"))
WEEKLY_PERCENT = float(ENV.get("RESOURCE_ALERTS_WEEKLY_PERCENT", "80"))
REMIND_SECONDS = float(ENV.get("RESOURCE_ALERTS_REMIND_HOURS", "6")) * 3600


def fetch(url: str, payload: object | None = None, headers: dict[str, str] | None = None, method: str | None = None) -> object:
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def management(key: str, path: str, payload: object | None = None) -> object:
    return fetch(MANAGEMENT_URL + path, payload, {"Authorization": f"Bearer {key}"}, "POST" if payload is not None else "GET")


def upstream_usage(key: str, auth: dict) -> dict:
    """Asks the provider for this account's live windows through the proxy, which injects the token."""
    headers = {"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json"}
    if auth["provider"] == "claude":
        url = "https://api.anthropic.com/api/oauth/usage"
        headers["anthropic-beta"] = "oauth-2025-04-20"
    else:
        account = auth.get("account")
        if isinstance(auth.get("id_token"), dict):
            account = auth["id_token"].get("chatgpt_account_id") or account
        if not isinstance(account, str) or not account:
            raise RuntimeError("no Codex account id")
        url = "https://chatgpt.com/backend-api/wham/usage"
        headers["User-Agent"] = "codex_cli_rs/0.160.0"
        headers["Chatgpt-Account-Id"] = account
    result = management(key, "/api-call", {"authIndex": auth["auth_index"], "method": "GET", "url": url, "header": headers})
    if not isinstance(result, dict) or result.get("status_code") != 200 or not isinstance(result.get("body"), str):
        raise RuntimeError("usage request failed")
    body = json.loads(result["body"])
    if not isinstance(body, dict):
        raise RuntimeError("usage response had an unexpected shape")
    return body


def number(value: object) -> float | None:
    try:
        return float(value) if value is not None and value != "" else None
    except (TypeError, ValueError):
        return None


def epoch(value: object) -> float | None:
    if isinstance(value, str) and not value.replace(".", "", 1).isdigit():
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return number(value)


def windows(auth: dict, body: dict | None) -> tuple[float | None, bool, float | None]:
    """Returns weekly used percent, whether any window is exhausted, and the weekly reset (epoch seconds)."""
    signals = (auth.get("quota") or {}).get("signals") or {}
    if auth["provider"] == "claude":
        weekly = (body or {}).get("seven_day") or {}
        short = (body or {}).get("five_hour") or {}
        used = number(weekly.get("utilization"))
        if used is None and number(signals.get("Anthropic-Ratelimit-Unified-7d-Utilization")) is not None:
            used = number(signals["Anthropic-Ratelimit-Unified-7d-Utilization"]) * 100
        limited = any((number(window.get("utilization")) or 0) >= 100 for window in (weekly, short)) or (
            body is None and signals.get("Anthropic-Ratelimit-Unified-Status") == "rejected")
        return used, limited, epoch(weekly.get("resets_at")) or epoch(signals.get("Anthropic-Ratelimit-Unified-7d-Reset"))
    limits = [window for window in ((body or {}).get("rate_limit") or {}).values() if isinstance(window, dict)]
    weekly = [window for window in limits if (window.get("limit_window_seconds") or 0) >= 86400]
    used = max((number(window.get("used_percent")) for window in weekly if number(window.get("used_percent")) is not None), default=None)
    if used is None and signals.get("X-Codex-Primary-Window-Minutes") == "10080":
        used = number(signals.get("X-Codex-Primary-Used-Percent"))
    limited = any((number(window.get("used_percent")) or 0) >= 100 for window in limits) or (
        body is None and signals.get("X-Codex-Limit-Reached") == "true")
    reset = min((epoch(window.get("reset_at")) for window in weekly if epoch(window.get("reset_at"))), default=None)
    return used, limited, reset or epoch(signals.get("X-Codex-Primary-Reset-At"))


def account_summary(key: str, auth: dict) -> dict:
    body = None
    if not auth.get("disabled"):
        try:
            body = upstream_usage(key, auth)
        except Exception:
            body = None  # Fall back to the rate-limit headers the proxy last saw.
    used, limited, reset = windows(auth, body)
    return {
        "id": auth.get("auth_index"),
        "provider": auth.get("provider"),
        "priority": auth.get("priority"),
        "status": auth.get("status"),
        "available": not auth.get("unavailable") and not auth.get("disabled"),
        "disabled": bool(auth.get("disabled")),
        "limitReached": limited,
        "weeklyUsedPercent": None if used is None else round(used, 1),
        "weeklyResetAt": reset,
        "live": body is not None,
    }


def write_atomic(path: Path, value: object, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(mode)
    temporary.replace(path)


def label(account: dict) -> str:
    return f"{account['provider']} account {account['id'][:6]} (priority {account['priority']})"


def collect() -> dict[str, str]:
    alerts: dict[str, str] = {}
    tmp = os.statvfs(TMP_PATH)
    used = 100 * (1 - tmp.f_bavail / tmp.f_blocks) if tmp.f_blocks else 0
    if used >= TMP_PERCENT:
        alerts["tmp"] = f"{TMP_PATH} is {used:.0f}% full ({tmp.f_bavail * tmp.f_frsize / 2**30:.1f} GiB free); threshold {TMP_PERCENT:.0f}%."

    try:
        key = MANAGEMENT_KEY.read_text().strip()
        files = management(key, "/auth-files")
        auths = [auth for auth in files.get("files", []) if auth.get("provider") in ("claude", "codex")]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            accounts = list(pool.map(lambda auth: account_summary(key, auth), auths))
        write_atomic(STATUS_FILE, {"observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "accounts": accounts}, 0o644)
        for account in accounts:
            if account["disabled"]:
                continue
            weekly = account["weeklyUsedPercent"] is not None and account["weeklyUsedPercent"] >= WEEKLY_PERCENT
            if not account["available"]:
                alerts[f"account:{account['id']}:unavailable"] = f"{label(account)} is unavailable (status {account['status']})."
            elif account["limitReached"] and not weekly:
                alerts[f"account:{account['id']}:limited"] = f"{label(account)} reached its short-window rate limit."
            if weekly:
                reset = f", resets {time.strftime('%a %d %b %H:%M', time.localtime(account['weeklyResetAt']))}" if account["weeklyResetAt"] else ""
                alerts[f"account:{account['id']}:weekly"] = f"{label(account)} used {account['weeklyUsedPercent']:.0f}% of its weekly limit{reset}."
    except Exception as error:
        alerts["proxy"] = f"Cannot read proxy accounts: {type(error).__name__}."

    try:
        health = fetch(BABYSITTER_HEALTH)
        agents = health.get("agents") or {}
        for agent in agents.values() if isinstance(agents, dict) else agents:
            for window, budget in (agent.get("budget") or {}).items():
                if window in ("hourly", "daily") and isinstance(budget, dict) and isinstance(budget.get("inputTokens"), (int, float)) and budget["inputTokens"] >= budget.get("limit", float("inf")):
                    alerts[f"babysitter:{window}"] = f"Babysitter used {budget['inputTokens'] / 1e6:.1f}M of its {budget['limit'] / 1e6:.0f}M {window} input-token budget; admission is paused until {time.strftime('%H:%M', time.localtime(budget['resetsAt'] / 1000))}."
    except Exception as error:
        alerts["babysitter"] = f"Cannot read Babysitter health: {type(error).__name__}."
    return alerts


def deliver(text: str) -> bool:
    for line in text.splitlines():
        print(f"<4>{line}", flush=True)  # journald warning priority
    if not WEBHOOK_FILE.exists():
        return True
    url = WEBHOOK_FILE.read_text().strip()
    try:
        fetch(url, {"content": text[:1900], "allowed_mentions": {"parse": []}}, {"User-Agent": "slimbook-resource-alerts"})
        return True
    except Exception as error:
        print(f"<3>Discord delivery failed: {type(error).__name__}", flush=True)
        return False


def main() -> int:
    now = time.time()
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {"active": {}}
    alerts = collect()
    active: dict[str, dict] = state.get("active", {})
    due = [key for key in alerts if key not in active or now - active[key]["notifiedAt"] >= REMIND_SECONDS]
    resolved = [key for key in active if key not in alerts]
    if not due and not resolved:
        return 0
    lines = ["Slimbook shared resources:"] + [f"- {alerts[key]}" for key in sorted(due)]
    lines += [f"- Resolved: {active[key]['text']}" for key in sorted(resolved)]
    if deliver("\n".join(lines)):
        for key in due:
            active[key] = {"text": alerts[key], "notifiedAt": now}
        for key in resolved:
            del active[key]
        write_atomic(STATE_FILE, {"active": active}, 0o600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
