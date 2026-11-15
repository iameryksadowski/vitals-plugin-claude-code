#!/usr/bin/env bash
# Cache Meter status line for the terminal.
#
# The plugin draws the line itself (the fields you chose with /plugin configure
# or /cache line ...) and writes it per session to $TMPDIR/cache-meter/<session>.line.
# This script only prints that file. Before the plugin has written it (the first
# moment of a session, or with the plugin off) it prints a short line from the
# status line JSON Claude Code hands it: account, model, limits and context.
# It sends nothing anywhere.
#
# settings.json of each account:
#   "statusLine": {"type": "command",
#     "command": "bash \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/cachemeter/bin/statusline.sh\""}
set -u

input="$(cat)"
session="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_.-]*\)".*/\1/p' | head -1)"
dir="${TMPDIR:-/tmp}"
dir="${dir%/}/cache-meter"
if [ -n "$session" ] && [ -s "$dir/$session.line" ]; then
  cat "$dir/$session.line"
  exit 0
fi

# Fallback: the plugin has not written this session's line yet.
config="${CLAUDE_CONFIG_DIR:-}"
case "$config" in
  ""|"$HOME/.claude"|"$HOME/.claude/") label="A" ;;
  *) label="$(basename "$config" | sed -e 's/^\.claude[-_.]//' -e 's/^\.//' | tr '[:lower:]' '[:upper:]')" ;;
esac
command -v jq >/dev/null 2>&1 || { printf '[%s]' "$label"; exit 0; }
printf '%s' "$input" | jq -r --arg label "$label" '
  def pct: if type == "number" then ((. + 0.5) | floor | tostring) + "%" else empty end;
  def hm: if type == "number" then (localtime | strftime("%H:%M")) else empty end;
  [ "[" + $label + "]" + (if (.model.display_name // "") != "" then " " + .model.display_name else "" end),
    (.rate_limits.five_hour | if . then "5h " + (.used_percentage | pct) + (if .resets_at then " (" + (.resets_at | hm) + ")" else "" end) else empty end),
    (.rate_limits.seven_day | if . then "7d " + (.used_percentage | pct) else empty end),
    (.context_window.used_percentage | if type == "number" then "ctx " + pct else empty end)
  ] | map(select(. != null and . != "")) | join(" · ")' 2>/dev/null || printf '[%s]' "$label"
